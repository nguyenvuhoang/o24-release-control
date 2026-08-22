package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Environment string          `json:"environment"`
	ListenAddr  string          `json:"listenAddr"`
	Compose     ComposeConfig   `json:"compose"`
	Services    []ServiceConfig `json:"services"`
}

type ComposeConfig struct {
	ProjectDirectory string   `json:"projectDirectory"`
	Files            []string `json:"files"`
	// BaseEnvFile is the server's existing, pre-provisioned env file (e.g.
	// /app/.env). It is never written by the agent — only read indirectly by
	// Compose itself — and carries every non-deployment setting the stack
	// depends on (ports, hostnames, secrets, etc). Optional: configs that
	// haven't migrated yet (see EnvFile) can leave this empty.
	BaseEnvFile string `json:"baseEnvFile"`
	// DeployEnvFile is the only file the agent ever writes to. It holds
	// nothing but the per-service IMAGE_* overrides.
	DeployEnvFile string `json:"deployEnvFile"`
	// EnvFile is the deprecated single-file config predating BaseEnvFile /
	// DeployEnvFile. loadConfig falls back to it as DeployEnvFile when the
	// new fields are absent, with no base file merged in (matching the old
	// behavior) — kept only so already-deployed agent-config.json files keep
	// working until migrated. New fields always take priority when present.
	EnvFile string `json:"envFile,omitempty"`
}

type ServiceConfig struct {
	Code                 string `json:"code"`
	DisplayName          string `json:"displayName"`
	ComposeService       string `json:"composeService"`
	ContainerName        string `json:"containerName"`
	ImageRepository      string `json:"imageRepository"`
	ImageEnvKey          string `json:"imageEnvKey"`
	HealthTimeoutSeconds int    `json:"healthTimeoutSeconds"`
}

type App struct {
	cfg       Config
	apiKey    string
	apiSecret string
	dataDir   string
	startedAt time.Time
	mu        sync.Mutex // serializes mutating docker/compose operations

	opMu       sync.Mutex
	operations map[string]*Operation
	opOrder    []string
}

type APIError struct {
	Error   string `json:"error"`
	Details string `json:"details,omitempty"`
}

type StatusResponse struct {
	Environment     string    `json:"environment"`
	AgentVersion    string    `json:"agentVersion"`
	DockerAvailable bool      `json:"dockerAvailable"`
	ComposeVersion  string    `json:"composeVersion,omitempty"`
	StartedAt       time.Time `json:"startedAt"`
	Timestamp       time.Time `json:"timestamp"`
}

// ServiceStatus reports three distinct image identifiers that must never be
// confused with one another:
//   - ImageRef: the reference the container was actually started from
//     (container Config.Image — e.g. "repo@sha256:..." or "repo:latest").
//   - ImageID: the local Docker image ID (container inspect .Image /
//     `sha256:<id>`). This is a local content hash, NOT a registry digest,
//     and must never be shown or used as one.
//   - RepoDigest: the immutable registry digest ("repo@sha256:...") for
//     ImageRepository, resolved either directly from ImageRef or by matching
//     the running image's RepoDigests. This is the only identifier safe to
//     use for promotion and DEV/UAT digest comparisons.
type ServiceStatus struct {
	Code            string            `json:"code"`
	DisplayName     string            `json:"displayName"`
	ComposeService  string            `json:"composeService"`
	ContainerName   string            `json:"containerName"`
	Status          string            `json:"status"`
	Health          string            `json:"health"`
	ImageRef        string            `json:"imageRef"`
	ImageID         string            `json:"imageId"`
	RepoDigest      string            `json:"repoDigest,omitempty"`
	GitRevision     string            `json:"gitRevision,omitempty"`
	StartedAt       string            `json:"startedAt,omitempty"`
	Labels          map[string]string `json:"labels,omitempty"`
	ConfiguredImage string            `json:"configuredImage,omitempty"`
	Error           string            `json:"error,omitempty"`
}

type DeployRequest struct {
	RequestID   string `json:"requestId"`
	Service     string `json:"service"`
	Digest      string `json:"digest,omitempty"`
	Image       string `json:"image,omitempty"`
	RequestedBy string `json:"requestedBy"`
	Reason      string `json:"reason,omitempty"`
}

type DeploymentRecord struct {
	RequestID     string    `json:"requestId"`
	Environment   string    `json:"environment"`
	Service       string    `json:"service"`
	Image         string    `json:"image"`
	PreviousImage string    `json:"previousImage,omitempty"`
	Status        string    `json:"status"`
	RequestedBy   string    `json:"requestedBy"`
	Reason        string    `json:"reason,omitempty"`
	StartedAt     time.Time `json:"startedAt"`
	CompletedAt   time.Time `json:"completedAt"`
	Error         string    `json:"error,omitempty"`
	Output        string    `json:"output,omitempty"`
}

type dockerInspect struct {
	ID      string `json:"Id"`
	Name    string `json:"Name"`
	Image   string `json:"Image"`
	Created string `json:"Created"`
	Config  struct {
		Image  string            `json:"Image"`
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	State struct {
		Status    string `json:"Status"`
		Running   bool   `json:"Running"`
		StartedAt string `json:"StartedAt"`
		Health    *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
}

type imageInspect struct {
	ID          string             `json:"Id"`
	RepoDigests []string           `json:"RepoDigests"`
	RepoTags    []string           `json:"RepoTags"`
	Config      imageInspectConfig `json:"Config"`
}

type imageInspectConfig struct {
	Labels map[string]string `json:"Labels"`
}

// ---- Async operations (deploy / restart / rollback) ----

type OperationLogLine struct {
	Index     int       `json:"index"`
	Timestamp time.Time `json:"timestamp"`
	Message   string    `json:"message"`
}

type OperationSnapshot struct {
	OperationID string             `json:"operationId"`
	Environment string             `json:"environment"`
	Service     string             `json:"service"`
	Action      string             `json:"action"`
	Image       string             `json:"image,omitempty"`
	Status      string             `json:"status"`
	StartedAt   time.Time          `json:"startedAt"`
	CompletedAt *time.Time         `json:"completedAt,omitempty"`
	Error       string             `json:"error,omitempty"`
	Logs        []OperationLogLine `json:"logs"`
}

// Operation tracks the progress of a single deploy/restart/rollback job.
// Readers wait on the notify channel (closed + replaced on every update) to
// learn about new log lines or a status change without polling.
type Operation struct {
	mu          sync.Mutex
	id          string
	environment string
	service     string
	action      string
	image       string
	status      string
	startedAt   time.Time
	completedAt time.Time
	errMsg      string
	logs        []OperationLogLine
	notify      chan struct{}
}

func newOperation(id, environment, service, action, image string) *Operation {
	return &Operation{
		id: id, environment: environment, service: service, action: action, image: image,
		status: "running", startedAt: time.Now().UTC(), notify: make(chan struct{}),
	}
}

func (o *Operation) log(message string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.logs = append(o.logs, OperationLogLine{Index: len(o.logs), Timestamp: time.Now().UTC(), Message: message})
	close(o.notify)
	o.notify = make(chan struct{})
}

func (o *Operation) complete(status, errMsg string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.status != "running" {
		return
	}
	o.status = status
	o.errMsg = errMsg
	o.completedAt = time.Now().UTC()
	close(o.notify)
	o.notify = make(chan struct{})
}

// snapshot returns a copy of the current logs/status plus the notify channel
// to wait on for the next update. Safe to call from any goroutine.
func (o *Operation) snapshot() (OperationSnapshot, chan struct{}) {
	o.mu.Lock()
	defer o.mu.Unlock()
	logsCopy := make([]OperationLogLine, len(o.logs))
	copy(logsCopy, o.logs)
	snap := OperationSnapshot{
		OperationID: o.id, Environment: o.environment, Service: o.service, Action: o.action,
		Image: o.image, Status: o.status, StartedAt: o.startedAt, Error: o.errMsg, Logs: logsCopy,
	}
	if o.status != "running" {
		completed := o.completedAt
		snap.CompletedAt = &completed
	}
	return snap, o.notify
}

const maxRetainedOperations = 200

func (a *App) createOperation(environment, service, action, image string) *Operation {
	id := fmt.Sprintf("op-%s-%d", action, time.Now().UnixNano())
	op := newOperation(id, environment, service, action, image)
	a.opMu.Lock()
	if a.operations == nil {
		a.operations = map[string]*Operation{}
	}
	a.operations[id] = op
	a.opOrder = append(a.opOrder, id)
	if len(a.opOrder) > maxRetainedOperations {
		oldest := a.opOrder[0]
		a.opOrder = a.opOrder[1:]
		delete(a.operations, oldest)
	}
	a.opMu.Unlock()
	return op
}

func (a *App) getOperation(id string) (*Operation, bool) {
	a.opMu.Lock()
	defer a.opMu.Unlock()
	op, ok := a.operations[id]
	return op, ok
}

// deployLabels provides the friendly step markers narrating progress. Every
// docker/docker compose invocation ALSO streams its real stdout/stderr,
// line by line, into the same operation log as it runs — these labels are
// bookmarks around that raw output, not a replacement for it.
type deployLabels struct {
	starting    string
	pulling     string
	pulled      string
	updatingEnv string
	recreating  string
	waiting     string
	checking    string // empty to skip this step
	completed   string
	failed      string
}

var deployStepLabels = deployLabels{
	starting: "Starting deployment", pulling: "Pulling image", pulled: "Image pulled",
	updatingEnv: "Updating env file", recreating: "Recreating container",
	waiting: "Waiting for container", checking: "Checking health/status",
	completed: "Deployment completed", failed: "Deployment failed",
}

var rollbackStepLabels = deployLabels{
	starting: "Loading previous deployment", pulling: "Pulling previous image", pulled: "Image pulled",
	updatingEnv: "Updating env", recreating: "Recreating container",
	waiting: "Waiting for service", checking: "",
	completed: "Rollback completed", failed: "Rollback failed",
}

var digestPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var requestIDPattern = regexp.MustCompile(`^[a-zA-Z0-9._:-]{1,120}$`)

const version = "1.3.0"

func main() {
	configPath := getenv("AGENT_CONFIG_PATH", "/config/agent-config.json")
	cfg, err := loadConfig(configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	apiKey := strings.TrimSpace(os.Getenv("AGENT_API_KEY"))
	apiSecret := strings.TrimSpace(os.Getenv("AGENT_API_SECRET"))
	if apiKey == "" || len(apiSecret) < 32 {
		log.Fatal("AGENT_API_KEY is required and AGENT_API_SECRET must contain at least 32 characters")
	}

	dataDir := getenv("AGENT_DATA_DIR", "/data")
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		log.Fatalf("create data dir: %v", err)
	}

	// docker compose must never fail just because the deploy env file hasn't
	// been created yet (fresh host, first-ever deploy). Touch it up front so
	// --env-file always resolves to a real, even if empty, file.
	if err := ensureFileExists(cfg.Compose.DeployEnvFile); err != nil {
		log.Fatalf("ensure deploy env file %s: %v", cfg.Compose.DeployEnvFile, err)
	}

	app := &App{
		cfg: cfg, apiKey: apiKey, apiSecret: apiSecret,
		dataDir: dataDir, startedAt: time.Now().UTC(),
		operations: map[string]*Operation{},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", app.handleHealth)
	mux.Handle("GET /api/status", app.auth(http.HandlerFunc(app.handleStatus)))
	mux.Handle("GET /api/services", app.auth(http.HandlerFunc(app.handleServices)))
	mux.Handle("GET /api/services/{service}/logs", app.auth(http.HandlerFunc(app.handleLogs)))
	mux.Handle("POST /api/services/{service}/restart", app.auth(http.HandlerFunc(app.handleRestart)))
	mux.Handle("POST /api/services/{service}/rollback", app.auth(http.HandlerFunc(app.handleRollback)))
	mux.Handle("POST /api/deploy", app.auth(http.HandlerFunc(app.handleDeploy)))
	mux.Handle("GET /api/operations/{operationId}", app.auth(http.HandlerFunc(app.handleOperationStatus)))
	mux.Handle("GET /api/operations/{operationId}/stream", app.auth(http.HandlerFunc(app.handleOperationStream)))

	addr := cfg.ListenAddr
	if strings.TrimSpace(addr) == "" {
		addr = ":9100"
	}

	server := &http.Server{
		Addr:              addr,
		Handler:           securityHeaders(requestLogger(mux)),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      0, // SSE streams can stay open indefinitely
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	log.Printf("O24 Deploy Agent %s listening on %s for environment %s", version, addr, cfg.Environment)
	log.Fatal(server.ListenAndServe())
}

func loadConfig(path string) (Config, error) {
	var cfg Config
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, err
	}
	if strings.TrimSpace(cfg.Environment) == "" {
		return cfg, errors.New("environment is required")
	}
	if strings.TrimSpace(cfg.Compose.ProjectDirectory) == "" || len(cfg.Compose.Files) == 0 {
		return cfg, errors.New("compose.projectDirectory and compose.files are required")
	}
	// Backward compatibility: configs written before baseEnvFile/deployEnvFile
	// existed only set the legacy envFile. New fields always win when present;
	// fall back to the old single-file behavior (no base file merge) only
	// when deployEnvFile itself is absent.
	if strings.TrimSpace(cfg.Compose.DeployEnvFile) == "" && strings.TrimSpace(cfg.Compose.EnvFile) != "" {
		cfg.Compose.DeployEnvFile = cfg.Compose.EnvFile
	}
	if strings.TrimSpace(cfg.Compose.DeployEnvFile) == "" {
		return cfg, errors.New("compose.deployEnvFile (or legacy compose.envFile) is required")
	}
	if cfg.Compose.BaseEnvFile != "" && cfg.Compose.BaseEnvFile == cfg.Compose.DeployEnvFile {
		return cfg, errors.New("compose.baseEnvFile and compose.deployEnvFile must be different paths")
	}
	seen := map[string]bool{}
	for i := range cfg.Services {
		s := &cfg.Services[i]
		if s.Code == "" || s.ComposeService == "" || s.ContainerName == "" || s.ImageRepository == "" || s.ImageEnvKey == "" {
			return cfg, fmt.Errorf("service at index %d is incomplete", i)
		}
		if seen[s.Code] {
			return cfg, fmt.Errorf("duplicate service code: %s", s.Code)
		}
		seen[s.Code] = true
		if s.HealthTimeoutSeconds <= 0 {
			s.HealthTimeoutSeconds = 60
		}
	}
	return cfg, nil
}

func (a *App) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("X-O24-Agent-Key")
		timestamp := r.Header.Get("X-O24-Timestamp")
		signature := r.Header.Get("X-O24-Signature")
		if subtle.ConstantTimeCompare([]byte(key), []byte(a.apiKey)) != 1 {
			writeJSON(w, http.StatusUnauthorized, APIError{Error: "unauthorized"})
			return
		}
		ts, err := strconv.ParseInt(timestamp, 10, 64)
		if err != nil || abs64(time.Now().Unix()-ts) > 300 {
			writeJSON(w, http.StatusUnauthorized, APIError{Error: "invalid_timestamp"})
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, APIError{Error: "invalid_body"})
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		bodyHash := sha256.Sum256(body)
		canonical := r.Method + "\n" + r.URL.RequestURI() + "\n" + timestamp + "\n" + hex.EncodeToString(bodyHash[:])
		mac := hmac.New(sha256.New, []byte(a.apiSecret))
		_, _ = mac.Write([]byte(canonical))
		expected := hex.EncodeToString(mac.Sum(nil))
		if !hmac.Equal([]byte(strings.ToLower(signature)), []byte(expected)) {
			writeJSON(w, http.StatusUnauthorized, APIError{Error: "invalid_signature"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "version": version, "environment": a.cfg.Environment})
}

func (a *App) handleStatus(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	_, dockerErr := runCommand(ctx, "docker", "version", "--format", "{{.Server.Version}}")
	composeVersion, composeErr := runCommand(ctx, "docker", "compose", "version", "--short")
	writeJSON(w, http.StatusOK, StatusResponse{
		Environment: a.cfg.Environment, AgentVersion: version,
		DockerAvailable: dockerErr == nil, ComposeVersion: strings.TrimSpace(composeVersion),
		StartedAt: a.startedAt, Timestamp: time.Now().UTC(),
	})
	if composeErr != nil {
		log.Printf("compose check failed: %v", composeErr)
	}
}

func (a *App) handleServices(w http.ResponseWriter, r *http.Request) {
	items := make([]ServiceStatus, 0, len(a.cfg.Services))
	for _, svc := range a.cfg.Services {
		items = append(items, a.inspectService(r.Context(), svc))
	}
	writeJSON(w, http.StatusOK, map[string]any{"environment": a.cfg.Environment, "items": items})
}

func (a *App) handleLogs(w http.ResponseWriter, r *http.Request) {
	svc, ok := a.findService(r.PathValue("service"))
	if !ok {
		writeJSON(w, http.StatusNotFound, APIError{Error: "service_not_found"})
		return
	}
	tail := 300
	if value := r.URL.Query().Get("tail"); value != "" {
		if n, err := strconv.Atoi(value); err == nil && n >= 1 && n <= 2000 {
			tail = n
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	output, err := runCommand(ctx, "docker", "logs", "--timestamps", "--tail", strconv.Itoa(tail), svc.ContainerName)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, APIError{Error: "logs_failed", Details: output})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"service": svc.Code, "tail": tail, "logs": output})
}

// handleRestart starts a restart operation in the background and returns the
// operationId immediately; clients follow progress via the operations endpoints.
func (a *App) handleRestart(w http.ResponseWriter, r *http.Request) {
	svc, ok := a.findService(r.PathValue("service"))
	if !ok {
		writeJSON(w, http.StatusNotFound, APIError{Error: "service_not_found"})
		return
	}
	op := a.createOperation(a.cfg.Environment, svc.Code, "restart", "")
	go a.runRestart(context.Background(), op, svc)
	writeJSON(w, http.StatusAccepted, map[string]any{"operationId": op.id, "status": "running"})
}

// handleDeploy starts a deploy operation in the background and returns the
// operationId immediately; clients follow progress via the operations endpoints.
func (a *App) handleDeploy(w http.ResponseWriter, r *http.Request) {
	var req DeployRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, APIError{Error: "invalid_request", Details: err.Error()})
		return
	}
	if req.RequestID == "" {
		req.RequestID = fmt.Sprintf("deploy-%d", time.Now().UnixNano())
	}
	if !requestIDPattern.MatchString(req.RequestID) {
		writeJSON(w, http.StatusBadRequest, APIError{Error: "invalid_request_id"})
		return
	}
	svc, ok := a.findService(req.Service)
	if !ok {
		writeJSON(w, http.StatusNotFound, APIError{Error: "service_not_found"})
		return
	}
	image, err := requestedImage(svc, req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, APIError{Error: "invalid_image", Details: err.Error()})
		return
	}

	op := a.createOperation(a.cfg.Environment, svc.Code, "deploy", image)
	go a.runDeploy(context.Background(), op, svc, image, req, deployStepLabels)
	writeJSON(w, http.StatusAccepted, map[string]any{"operationId": op.id, "status": "running"})
}

// handleRollback starts a rollback operation in the background and returns the
// operationId immediately; clients follow progress via the operations endpoints.
func (a *App) handleRollback(w http.ResponseWriter, r *http.Request) {
	svc, ok := a.findService(r.PathValue("service"))
	if !ok {
		writeJSON(w, http.StatusNotFound, APIError{Error: "service_not_found"})
		return
	}
	previous, err := a.findRollbackImage(svc.Code)
	if err != nil {
		writeJSON(w, http.StatusConflict, APIError{Error: "rollback_unavailable", Details: err.Error()})
		return
	}
	op := a.createOperation(a.cfg.Environment, svc.Code, "rollback", previous)
	req := DeployRequest{
		RequestID: fmt.Sprintf("rollback-%d", time.Now().UnixNano()),
		Service:   svc.Code, Image: previous, RequestedBy: "control-center", Reason: "rollback",
	}
	go a.runDeploy(context.Background(), op, svc, previous, req, rollbackStepLabels)
	writeJSON(w, http.StatusAccepted, map[string]any{"operationId": op.id, "status": "running"})
}

// handleOperationStatus lets a client re-read status + full log history after
// a page reload, without needing the SSE stream.
func (a *App) handleOperationStatus(w http.ResponseWriter, r *http.Request) {
	op, ok := a.getOperation(r.PathValue("operationId"))
	if !ok {
		writeJSON(w, http.StatusNotFound, APIError{Error: "operation_not_found"})
		return
	}
	snap, _ := op.snapshot()
	writeJSON(w, http.StatusOK, snap)
}

// handleOperationStream streams whitelisted progress log lines for a single
// operation as Server-Sent Events, replaying history first, then live-tailing
// until the operation reaches a terminal status.
func (a *App) handleOperationStream(w http.ResponseWriter, r *http.Request) {
	op, ok := a.getOperation(r.PathValue("operationId"))
	if !ok {
		writeJSON(w, http.StatusNotFound, APIError{Error: "operation_not_found"})
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, APIError{Error: "streaming_unsupported"})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ctx := r.Context()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	sent := 0
	for {
		snap, notify := op.snapshot()
		for sent < len(snap.Logs) {
			if err := writeSSE(w, flusher, "log", snap.Logs[sent]); err != nil {
				return
			}
			sent++
		}
		if snap.Status != "running" {
			_ = writeSSE(w, flusher, "status", snap)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-notify:
			continue
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func writeSSE(w http.ResponseWriter, flusher http.Flusher, event string, data any) error {
	payload, err := json.Marshal(data)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, payload); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}

func requestedImage(svc ServiceConfig, req DeployRequest) (string, error) {
	if req.Digest != "" {
		digest := strings.ToLower(strings.TrimSpace(req.Digest))
		if !digestPattern.MatchString(digest) {
			return "", errors.New("digest must match sha256:<64 lowercase hex characters>")
		}
		return svc.ImageRepository + "@" + digest, nil
	}
	image := strings.TrimSpace(req.Image)
	if image == "" {
		return "", errors.New("digest or image is required")
	}
	if !strings.HasPrefix(image, svc.ImageRepository+"@sha256:") || !digestPattern.MatchString(strings.TrimPrefix(image, svc.ImageRepository+"@")) {
		return "", errors.New("only an immutable image from the configured repository is allowed")
	}
	return image, nil
}

// runRestart executes `docker restart` for a service, narrating whitelisted
// progress steps to the operation log as it goes.
func (a *App) runRestart(parent context.Context, op *Operation, svc ServiceConfig) {
	op.log("Restart requested")
	a.mu.Lock()
	defer a.mu.Unlock()

	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()

	op.log("Stopping container")
	restartOutput, err := runStreamedCommand(ctx, op, "docker", "restart", svc.ContainerName)
	if err != nil {
		exitCode := exitCodeOf(err)
		op.log(fmt.Sprintf("Docker restart exited with code %d", exitCode))
		op.log("Restart failed")
		op.complete("failed", composeFailureMessage("docker restart", exitCode, restartOutput, err))
		return
	}
	op.log("Starting container")
	op.log("Waiting for running state")
	if _, err := a.waitHealthy(ctx, svc); err != nil {
		op.log("Restart failed")
		op.complete("failed", err.Error())
		return
	}
	op.log("Restart completed")
	op.complete("success", "")
}

// runDeploy pulls the target image, updates the environment file and
// recreates the container, narrating whitelisted progress steps to the
// operation log as it goes. It backs /api/deploy (deployStepLabels — this
// covers both a plain redeploy and a promote, since promote is just a deploy
// request against the target environment carrying the source environment's
// current digest) and /api/services/{service}/rollback (rollbackStepLabels).
// Deliberately NOT used by restart (runRestart): a restart never changes
// which image is configured, so none of this — env file writes, compose
// pull, digest verification — applies there.
//
// Both `docker compose pull` and `docker compose up` go through
// composeArgs(), which resolves the project directory and --env-file flags
// entirely from config (never a hardcoded path) and merges baseEnvFile with
// deployEnvFile — so pull/up always resolve the service's image from the
// exact same merged env files, in the exact order compose sees them.
func (a *App) runDeploy(parent context.Context, op *Operation, svc ServiceConfig, image string, req DeployRequest, labels deployLabels) {
	op.log(labels.starting)
	a.mu.Lock()
	defer a.mu.Unlock()

	started := time.Now().UTC()
	previous, _ := readEnvValue(a.cfg.Compose.DeployEnvFile, svc.ImageEnvKey)
	record := DeploymentRecord{
		RequestID: req.RequestID, Environment: a.cfg.Environment, Service: svc.Code,
		Image: image, PreviousImage: previous, Status: "running", RequestedBy: req.RequestedBy,
		Reason: req.Reason, StartedAt: started,
	}

	ctx, cancel := context.WithTimeout(parent, 10*time.Minute)
	defer cancel()
	var output strings.Builder

	// The env file must carry the target image BEFORE pull/up run: both now
	// go through `docker compose`, which resolves the service's `image:`
	// from the merged --env-file values rather than from a literal string
	// passed on the command line.
	op.log(labels.updatingEnv)
	if err := updateEnvAtomic(a.cfg.Compose.DeployEnvFile, svc.ImageEnvKey, image); err != nil {
		op.log(labels.failed)
		record.Status, record.Error = "failed", "update deployment env failed: "+err.Error()
		a.finishDeployment(record, output.String())
		op.complete("failed", record.Error)
		return
	}

	composeUpArgs := a.composeArgs("up", "-d", "--no-deps", "--force-recreate", svc.ComposeService)

	op.log(labels.pulling)
	composePullArgs := a.composeArgs("pull", svc.ComposeService)
	pullOutput, err := runStreamedCommand(ctx, op, "docker", composePullArgs...)
	output.WriteString("$ docker " + strings.Join(composePullArgs, " ") + "\n" + pullOutput + "\n")
	if err != nil {
		exitCode := exitCodeOf(err)
		op.log(fmt.Sprintf("Docker Compose pull exited with code %d", exitCode))
		op.log(labels.failed)
		record.Status, record.Error = "failed", composeFailureMessage("docker compose pull", exitCode, pullOutput, err)
		if previous != "" && previous != image {
			// Nothing was recreated yet — just revert the env file so it
			// doesn't keep pointing at an image that failed to pull.
			_ = updateEnvAtomic(a.cfg.Compose.DeployEnvFile, svc.ImageEnvKey, previous)
		}
		a.finishDeployment(record, output.String())
		op.complete("failed", record.Error)
		return
	}
	op.log(labels.pulled)

	op.log(labels.recreating)
	upOutput, composeErr := runStreamedCommand(ctx, op, "docker", composeUpArgs...)
	output.WriteString("$ docker " + strings.Join(composeUpArgs, " ") + "\n" + upOutput + "\n")

	var final ServiceStatus
	if composeErr != nil {
		exitCode := exitCodeOf(composeErr)
		op.log(fmt.Sprintf("Docker Compose exited with code %d", exitCode))
		err = errors.New(composeFailureMessage("docker compose", exitCode, upOutput, composeErr))
	} else {
		op.log(labels.waiting)
		final, err = a.waitHealthy(ctx, svc)
	}
	if err != nil {
		op.log(labels.failed)
		record.Status, record.Error = "failed", err.Error()
		a.attemptRollback(ctx, op, svc, composeUpArgs, previous, image, &record, &output)
		a.finishDeployment(record, output.String())
		op.complete("failed", record.Error)
		return
	}
	if labels.checking != "" {
		op.log(labels.checking)
	}

	// Digest verification gate: `docker compose up` exiting 0 and the
	// container reporting healthy do NOT by themselves prove it is running
	// the requested image — e.g. if docker-compose.yml's `image:` line isn't
	// actually wired to ImageEnvKey, compose can happily "succeed" against a
	// stale local tag. SUCCESS is reported only once `final` (the inspect
	// waitHealthy just confirmed "running" against) shows the container's
	// own resolved repoDigest equals what was requested; requestedDigest is
	// "" (verification skipped, never treated as failure) only for image
	// strings not in the standard repository@sha256 form produced by
	// requestedImage/findRollbackImage.
	if requestedDigest := requestedDigestOf(svc, image); requestedDigest != "" {
		actual := strings.ToLower(strings.TrimPrefix(final.RepoDigest, "sha256:"))
		wanted := strings.ToLower(strings.TrimPrefix(requestedDigest, "sha256:"))
		if actual == "" || actual != wanted {
			shown := final.RepoDigest
			if shown == "" {
				shown = "(không xác định được digest đang chạy)"
			}
			verifyErr := fmt.Sprintf(
				"deploy verification failed: container running digest %s, expected sha256:%s — docker-compose có thể chưa đọc đúng %s (kiểm tra image: trong docker-compose.yml trỏ tới biến này)",
				shown, wanted, svc.ImageEnvKey,
			)
			op.log(verifyErr)
			op.log(labels.failed)
			record.Status, record.Error = "failed", verifyErr
			a.attemptRollback(ctx, op, svc, composeUpArgs, previous, image, &record, &output)
			a.finishDeployment(record, output.String())
			op.complete("failed", record.Error)
			return
		}
	}

	record.Status = "succeeded"
	a.finishDeployment(record, output.String())
	op.log(labels.completed)
	op.complete("success", "")
}

// requestedDigestOf extracts the bare "sha256:<hex>" digest from an image
// string built by requestedImage/findRollbackImage ("repository@sha256:..."),
// returning "" when image isn't in that exact form (e.g. legacy stored
// data). Callers must treat "" as "digest verification not possible", never
// as a mismatch — this function only ever reads back what was itself just
// requested, so it can't produce a false failure.
func requestedDigestOf(svc ServiceConfig, image string) string {
	prefix := svc.ImageRepository + "@"
	if !strings.HasPrefix(image, prefix) {
		return ""
	}
	digest := strings.TrimPrefix(image, prefix)
	if !digestPattern.MatchString(digest) {
		return ""
	}
	return digest
}

// attemptRollback best-effort reverts svc.ImageEnvKey to previous and
// re-recreates the container via upArgs, appending its own progress to
// output/record.Error. No-ops when there is no distinct previous image to
// fall back to (e.g. this was the service's first-ever deploy).
func (a *App) attemptRollback(ctx context.Context, op *Operation, svc ServiceConfig, upArgs []string, previous, image string, record *DeploymentRecord, output *strings.Builder) {
	if previous == "" || previous == image {
		return
	}
	output.WriteString("Automatic rollback to " + previous + "\n")
	op.log("Automatic rollback to " + previous)
	_ = updateEnvAtomic(a.cfg.Compose.DeployEnvFile, svc.ImageEnvKey, previous)
	rollbackOutput, rollbackErr := runStreamedCommand(ctx, op, "docker", upArgs...)
	output.WriteString(rollbackOutput + "\n")
	if rollbackErr != nil {
		rollbackExitCode := exitCodeOf(rollbackErr)
		op.log(fmt.Sprintf("Automatic rollback exited with code %d", rollbackExitCode))
		record.Error += "; automatic rollback failed: " + composeFailureMessage("docker compose", rollbackExitCode, rollbackOutput, rollbackErr)
	}
}

// waitHealthy polls until svc reports running+healthy, returning the last
// inspected ServiceStatus either way so callers that need to act on it
// afterwards (e.g. runDeploy's digest verification gate) don't have to pay
// for a second `docker inspect` round-trip.
func (a *App) waitHealthy(ctx context.Context, svc ServiceConfig) (ServiceStatus, error) {
	deadline := time.Now().Add(time.Duration(svc.HealthTimeoutSeconds) * time.Second)
	var last ServiceStatus
	for time.Now().Before(deadline) {
		last = a.inspectService(ctx, svc)
		if last.Status == "running" && (last.Health == "healthy" || last.Health == "none") {
			return last, nil
		}
		select {
		case <-ctx.Done():
			return last, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return last, fmt.Errorf("health check timed out: status=%s health=%s error=%s", last.Status, last.Health, last.Error)
}

func (a *App) finishDeployment(record DeploymentRecord, output string) DeploymentRecord {
	record.CompletedAt = time.Now().UTC()
	record.Output = trimOutput(output, 12000)
	if err := a.appendDeployment(record); err != nil {
		log.Printf("append deployment: %v", err)
	}
	return record
}

// composeArgs builds the `docker compose` invocation. When baseEnvFile is
// configured, the two --env-file flags MUST stay in this order: baseEnvFile
// first (the server's existing config), deployEnvFile second (the agent's
// own image overrides). Compose applies later --env-file values on top of
// earlier ones for the same key, so this order lets a deploy override just
// the IMAGE_* keys without losing any other setting the server's real .env
// carries. baseEnvFile is omitted entirely for configs still running on the
// legacy single-file (envFile) setup — see ComposeConfig.EnvFile.
func (a *App) composeArgs(args ...string) []string {
	result := []string{"compose", "--project-directory", a.cfg.Compose.ProjectDirectory}
	for _, file := range a.cfg.Compose.Files {
		result = append(result, "-f", file)
	}
	if a.cfg.Compose.BaseEnvFile != "" {
		result = append(result, "--env-file", a.cfg.Compose.BaseEnvFile)
	}
	result = append(result, "--env-file", a.cfg.Compose.DeployEnvFile)
	return append(result, args...)
}

func (a *App) inspectService(parent context.Context, svc ServiceConfig) ServiceStatus {
	configuredImage, _ := readEnvValue(a.cfg.Compose.DeployEnvFile, svc.ImageEnvKey)
	result := ServiceStatus{
		Code: svc.Code, DisplayName: svc.DisplayName, ComposeService: svc.ComposeService,
		ContainerName: svc.ContainerName, Status: "missing", Health: "unknown",
		ConfiguredImage: configuredImage,
	}
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	output, err := runCommand(ctx, "docker", "inspect", svc.ContainerName)
	if err != nil {
		result.Error = strings.TrimSpace(output)
		return result
	}
	var inspectItems []dockerInspect
	if err := json.Unmarshal([]byte(output), &inspectItems); err != nil || len(inspectItems) == 0 {
		result.Error = "invalid docker inspect output"
		return result
	}
	item := inspectItems[0]
	result.Status = item.State.Status
	result.Health = "none"
	if item.State.Health != nil {
		result.Health = item.State.Health.Status
	}
	result.ImageRef = item.Config.Image
	result.ImageID = item.Image
	result.StartedAt = item.State.StartedAt
	result.Labels = item.Config.Labels

	var repoDigests []string
	imageOutput, imageErr := runCommand(ctx, "docker", "image", "inspect", item.Image)
	if imageErr == nil {
		var images []imageInspect
		if json.Unmarshal([]byte(imageOutput), &images) == nil && len(images) > 0 {
			repoDigests = images[0].RepoDigests
			if images[0].Config.Labels != nil {
				result.GitRevision = images[0].Config.Labels["org.opencontainers.image.revision"]
			}
		}
	}
	result.RepoDigest = resolveRepoDigest(item.Config.Image, svc.ImageRepository, repoDigests)
	return result
}

// resolveRepoDigest resolves the immutable registry digest for a service's
// image, distinct from the local Docker image ID. Two paths, tried in order:
//  1. If configImage (container Config.Image) is already an immutable
//     "repo@sha256:..." reference for imageRepository, the digest is read
//     directly from it — no ambiguity possible.
//  2. Otherwise (e.g. configImage is "repo:latest"), fall back to matching
//     repoDigests (from `docker image inspect` on the running image) against
//     imageRepository, since the tag alone doesn't carry a digest. Each
//     candidate is checked with Docker Hub's registry-alias prefixes
//     ("docker.io/", "index.docker.io/") stripped first, since Docker
//     sometimes reports RepoDigests fully-qualified even though
//     imageRepository is configured in short form.
//
// Returns "" if neither path yields a digest for imageRepository — this
// function never falls back to the local Docker image ID.
func resolveRepoDigest(configImage, imageRepository string, repoDigests []string) string {
	prefix := imageRepository + "@sha256:"
	if strings.HasPrefix(configImage, prefix) {
		return strings.TrimPrefix(configImage, imageRepository+"@")
	}
	for _, repoDigest := range repoDigests {
		normalized := stripRegistryAlias(repoDigest)
		if strings.HasPrefix(normalized, prefix) {
			return strings.TrimPrefix(normalized, imageRepository+"@")
		}
	}
	return ""
}

// stripRegistryAlias removes Docker Hub's registry-alias prefixes that
// RepoDigests entries can carry depending on Docker version/how an image was
// pulled, so matching against a short-form configured repository name (e.g.
// "vknighthub/ips_o24cms") doesn't silently miss a real digest.
func stripRegistryAlias(repoDigest string) string {
	for _, alias := range []string{"index.docker.io/", "docker.io/"} {
		if strings.HasPrefix(repoDigest, alias) {
			return strings.TrimPrefix(repoDigest, alias)
		}
	}
	return repoDigest
}

func (a *App) findService(code string) (ServiceConfig, bool) {
	for _, svc := range a.cfg.Services {
		if svc.Code == code {
			return svc, true
		}
	}
	return ServiceConfig{}, false
}

func (a *App) appendDeployment(record DeploymentRecord) error {
	path := filepath.Join(a.dataDir, "deployments.jsonl")
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640)
	if err != nil {
		return err
	}
	defer file.Close()
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	_, err = file.Write(append(data, '\n'))
	return err
}

func (a *App) findRollbackImage(service string) (string, error) {
	path := filepath.Join(a.dataDir, "deployments.jsonl")
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	var records []DeploymentRecord
	scanner := bufio.NewScanner(file)
	buffer := make([]byte, 64*1024)
	scanner.Buffer(buffer, 2*1024*1024)
	for scanner.Scan() {
		var record DeploymentRecord
		if json.Unmarshal(scanner.Bytes(), &record) == nil && record.Service == service && record.Status == "succeeded" && record.PreviousImage != "" {
			records = append(records, record)
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	if len(records) == 0 {
		return "", errors.New("no previous successful image was found")
	}
	return records[len(records)-1].PreviousImage, nil
}

func runCommand(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), "DOCKER_CLI_HINTS=false")
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	err := cmd.Run()
	return output.String(), err
}

// runStreamedCommand runs a command and pushes every stdout/stderr line into
// the operation log the moment it is produced, instead of buffering
// everything until the process exits. Stdout and stderr are combined onto a
// single pipe (like shell `2>&1`) so interleaving matches real chronological
// order as closely as Docker's own output allows. The full combined output
// is also returned so callers can still persist it (e.g. DeploymentRecord).
//
// Only the command name and arguments are logged — never env file contents
// or secret values, which never pass through this function's arguments in
// the first place (paths and flags only).
func runStreamedCommand(ctx context.Context, op *Operation, name string, args ...string) (string, error) {
	if op != nil {
		op.log("$ " + name + " " + strings.Join(args, " "))
	}

	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), "DOCKER_CLI_HINTS=false")

	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw

	var output strings.Builder
	done := make(chan struct{})
	go func() {
		defer close(done)
		scanner := bufio.NewScanner(pr)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			output.WriteString(line)
			output.WriteString("\n")
			if op != nil {
				op.log(line)
			}
		}
	}()

	if err := cmd.Start(); err != nil {
		_ = pw.Close()
		<-done
		return output.String(), err
	}
	waitErr := cmd.Wait()
	_ = pw.Close()
	<-done
	return output.String(), waitErr
}

// exitCodeOf extracts the process exit code from a command error, or -1 if
// the command never got as far as producing one (e.g. it failed to start).
func exitCodeOf(err error) int {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}

// lastNonEmptyLine returns the last non-blank line of captured command
// output — typically the most specific error Docker/Compose printed.
func lastNonEmptyLine(output string) string {
	lines := strings.Split(strings.TrimRight(output, "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// composeFailureMessage builds a short, honest failure summary from a
// command's exit code and captured output instead of a bare "exit status N".
// The full raw output has already been streamed into the operation log by
// runStreamedCommand; this is just the headline used for the operation's
// final error field, the deployment record and the audit trail.
func composeFailureMessage(label string, exitCode int, output string, err error) string {
	detail := lastNonEmptyLine(output)
	if detail == "" {
		detail = err.Error()
	}
	if exitCode >= 0 {
		return fmt.Sprintf("%s exited with code %d: %s", label, exitCode, detail)
	}
	return fmt.Sprintf("%s failed: %s", label, detail)
}

// ensureFileExists creates an empty file (and its parent directory) at path
// if nothing is there yet. It never truncates or otherwise touches an
// already-existing file. Used at startup so `docker compose --env-file
// <deployEnvFile>` always has a real file to read, even before the first
// deploy has ever run on a fresh host.
func ensureFileExists(path string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o640)
	if err != nil {
		return err
	}
	return file.Close()
}

func readEnvValue(path, key string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	prefix := key + "="
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, prefix) {
			return strings.Trim(strings.TrimSpace(strings.TrimPrefix(line, prefix)), `"'`), nil
		}
	}
	return "", scanner.Err()
}

func updateEnvAtomic(path, key, value string) error {
	if strings.ContainsAny(value, "\r\n") {
		return errors.New("invalid env value")
	}
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	found := false
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, key+"=") {
			lines[i] = key + "=" + value
			found = true
		}
	}
	if !found {
		if len(lines) > 0 && lines[len(lines)-1] != "" {
			lines = append(lines, "")
		}
		lines = append(lines, key+"="+value)
	}
	content := strings.Join(lines, "\n")
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".env.deploy-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o640); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(content); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.RequestURI(), time.Since(started).Round(time.Millisecond))
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func trimOutput(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[len(value)-max:]
}

func getenv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func abs64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}
