package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestUpdateEnvAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env.deploy")
	if err := os.WriteFile(path, []byte("A=1\nO24_WFO_IMAGE=old\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := updateEnvAtomic(path, "O24_WFO_IMAGE", "repo@sha256:abc"); err != nil {
		t.Fatal(err)
	}
	value, err := readEnvValue(path, "O24_WFO_IMAGE")
	if err != nil {
		t.Fatal(err)
	}
	if value != "repo@sha256:abc" {
		t.Fatalf("unexpected value: %s", value)
	}
}

func TestRequestedImage(t *testing.T) {
	svc := ServiceConfig{ImageRepository: "vknighthub/ips_o24wfo"}
	digest := "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	image, err := requestedImage(svc, DeployRequest{Digest: digest})
	if err != nil {
		t.Fatal(err)
	}
	if image != "vknighthub/ips_o24wfo@"+digest {
		t.Fatalf("unexpected image: %s", image)
	}
}

func TestResolveRepoDigest(t *testing.T) {
	repo := "vknighthub/ips_o24wfo"
	digest := "sha256:1753aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

	t.Run("reads digest directly from an already-immutable config image", func(t *testing.T) {
		got := resolveRepoDigest(repo+"@"+digest, repo, []string{"unrelated/repo@sha256:deadbeef"})
		if got != digest {
			t.Fatalf("expected %s, got %s", digest, got)
		}
	})

	t.Run("falls back to matching RepoDigests when config image is a mutable tag", func(t *testing.T) {
		got := resolveRepoDigest(repo+":latest", repo, []string{"unrelated/repo@sha256:deadbeef", repo + "@" + digest})
		if got != digest {
			t.Fatalf("expected %s, got %s", digest, got)
		}
	})

	t.Run("returns empty when no RepoDigests match the configured repository", func(t *testing.T) {
		got := resolveRepoDigest(repo+":latest", repo, []string{"unrelated/repo@sha256:deadbeef"})
		if got != "" {
			t.Fatalf("expected empty digest, got %q", got)
		}
	})

	t.Run("direct extraction wins even when repoDigests would also match", func(t *testing.T) {
		other := "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		got := resolveRepoDigest(repo+"@"+digest, repo, []string{repo + "@" + other})
		if got != digest {
			t.Fatalf("expected direct digest %s to win over repoDigests match %s, got %s", digest, other, got)
		}
	})

	t.Run("picks the matching entry out of multiple RepoDigests", func(t *testing.T) {
		other := "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
		got := resolveRepoDigest(repo+":latest", repo, []string{
			"unrelated/repo@sha256:deadbeef",
			"another/unrelated@" + other,
			repo + "@" + digest,
		})
		if got != digest {
			t.Fatalf("expected %s, got %s", digest, got)
		}
	})

	t.Run("normalizes docker.io and index.docker.io aliases before matching", func(t *testing.T) {
		gotDockerIO := resolveRepoDigest(repo+":latest", repo, []string{"docker.io/" + repo + "@" + digest})
		if gotDockerIO != digest {
			t.Fatalf("expected %s from docker.io/ alias, got %s", digest, gotDockerIO)
		}
		gotIndexDockerIO := resolveRepoDigest(repo+":latest", repo, []string{"index.docker.io/" + repo + "@" + digest})
		if gotIndexDockerIO != digest {
			t.Fatalf("expected %s from index.docker.io/ alias, got %s", digest, gotIndexDockerIO)
		}
	})

	t.Run("never falls back to a local image ID when RepoDigests is empty", func(t *testing.T) {
		localImageID := "sha256:6fd8478b1ba307003c9261826d9d295095bf7fa5eacbd4b9fddfd548fdcc186c"
		got := resolveRepoDigest(repo+":latest", repo, nil)
		if got != "" {
			t.Fatalf("expected empty digest when RepoDigests has nothing for this repository, got %q", got)
		}
		if got == localImageID {
			t.Fatalf("resolveRepoDigest must never return a local image ID")
		}
	})
}

func TestRequestedDigestOf(t *testing.T) {
	svc := ServiceConfig{ImageRepository: "vknighthub/ips_o24cms"}
	digest := "sha256:d7ab5595faa22357b23bdd3dd1b5db4d77c27738d55209eb0a03524ec88a7a03"

	t.Run("extracts the bare digest from a repository@sha256 image", func(t *testing.T) {
		got := requestedDigestOf(svc, svc.ImageRepository+"@"+digest)
		if got != digest {
			t.Fatalf("expected %s, got %s", digest, got)
		}
	})

	t.Run("returns empty for a mutable tag reference", func(t *testing.T) {
		got := requestedDigestOf(svc, svc.ImageRepository+":latest")
		if got != "" {
			t.Fatalf("expected empty, got %q", got)
		}
	})

	t.Run("returns empty for a different repository's pinned reference", func(t *testing.T) {
		got := requestedDigestOf(svc, "unrelated/repo@"+digest)
		if got != "" {
			t.Fatalf("expected empty, got %q", got)
		}
	})

	t.Run("returns empty for a malformed digest suffix", func(t *testing.T) {
		got := requestedDigestOf(svc, svc.ImageRepository+"@sha256:not-hex")
		if got != "" {
			t.Fatalf("expected empty, got %q", got)
		}
	})
}

func TestOperationLogAndComplete(t *testing.T) {
	op := newOperation("op-test-1", "dev", "wfo", "deploy", "repo@sha256:abc")

	op.log("Starting deployment")
	op.log("Pulling image")

	snap, notify := op.snapshot()
	if snap.Status != "running" {
		t.Fatalf("expected running status, got %s", snap.Status)
	}
	if len(snap.Logs) != 2 {
		t.Fatalf("expected 2 log lines, got %d", len(snap.Logs))
	}
	if snap.Logs[0].Message != "Starting deployment" || snap.Logs[0].Index != 0 {
		t.Fatalf("unexpected first log line: %+v", snap.Logs[0])
	}
	if snap.Logs[1].Message != "Pulling image" || snap.Logs[1].Index != 1 {
		t.Fatalf("unexpected second log line: %+v", snap.Logs[1])
	}

	select {
	case <-notify:
		t.Fatal("notify channel should not be closed before the next update")
	default:
	}

	op.complete("success", "")

	select {
	case <-notify:
	default:
		t.Fatal("notify channel should be closed after an update")
	}

	finalSnap, _ := op.snapshot()
	if finalSnap.Status != "success" {
		t.Fatalf("expected success status, got %s", finalSnap.Status)
	}
	if finalSnap.CompletedAt == nil {
		t.Fatal("expected completedAt to be set")
	}

	// complete() must be idempotent: a second call must not overwrite the
	// terminal status once set.
	op.complete("failed", "should not apply")
	afterSecondComplete, _ := op.snapshot()
	if afterSecondComplete.Status != "success" {
		t.Fatalf("expected status to remain success, got %s", afterSecondComplete.Status)
	}
}

func TestComposeArgsUsesBaseThenDeployEnvFile(t *testing.T) {
	app := &App{
		cfg: Config{
			Compose: ComposeConfig{
				ProjectDirectory: "/app",
				Files:            []string{"/app/docker-compose.yml"},
				BaseEnvFile:      "/app/.env",
				DeployEnvFile:    "/app/.env.deploy",
			},
		},
	}

	args := app.composeArgs("up", "-d", "--no-deps", "--force-recreate", "o24-wfo")

	baseIdx, deployIdx := -1, -1
	for i, arg := range args {
		if arg == "/app/.env" {
			baseIdx = i
		}
		if arg == "/app/.env.deploy" {
			deployIdx = i
		}
	}
	if baseIdx == -1 {
		t.Fatalf("expected baseEnvFile /app/.env in args: %v", args)
	}
	if deployIdx == -1 {
		t.Fatalf("expected deployEnvFile /app/.env.deploy in args: %v", args)
	}
	if baseIdx >= deployIdx {
		t.Fatalf("expected baseEnvFile to appear before deployEnvFile so deploy overrides base, got args: %v", args)
	}
	// Each --env-file flag must immediately precede its path.
	if args[baseIdx-1] != "--env-file" || args[deployIdx-1] != "--env-file" {
		t.Fatalf("expected --env-file immediately before each env file path, got args: %v", args)
	}
}

// TestComposeArgsDerivesDirectoryFromConfigNotHardcoded proves composeArgs —
// used for both `docker compose pull` and `docker compose up` — never
// assumes "/app" — deploy/promote/rollback must work with whatever
// projectDirectory/env file paths the server's agent-config.json declares,
// and pull/up must resolve the image from the same two --env-file flags.
func TestComposeArgsDerivesDirectoryFromConfigNotHardcoded(t *testing.T) {
	app := &App{
		cfg: Config{
			Compose: ComposeConfig{
				ProjectDirectory: "/srv/o24/uat",
				Files:            []string{"/srv/o24/uat/docker-compose.yml"},
				BaseEnvFile:      "/srv/o24/uat/.env",
				DeployEnvFile:    "/srv/o24/uat/.env.deploy",
			},
		},
	}

	pullArgs := app.composeArgs("pull", "o24-cms")
	wantPull := []string{
		"compose", "--project-directory", "/srv/o24/uat",
		"-f", "/srv/o24/uat/docker-compose.yml",
		"--env-file", "/srv/o24/uat/.env",
		"--env-file", "/srv/o24/uat/.env.deploy",
		"pull", "o24-cms",
	}
	if strings.Join(pullArgs, " ") != strings.Join(wantPull, " ") {
		t.Fatalf("pull args mismatch:\n got: %v\nwant: %v", pullArgs, wantPull)
	}

	upArgs := app.composeArgs("up", "-d", "--no-deps", "--force-recreate", "o24-cms")
	wantUp := []string{
		"compose", "--project-directory", "/srv/o24/uat",
		"-f", "/srv/o24/uat/docker-compose.yml",
		"--env-file", "/srv/o24/uat/.env",
		"--env-file", "/srv/o24/uat/.env.deploy",
		"up", "-d", "--no-deps", "--force-recreate", "o24-cms",
	}
	if strings.Join(upArgs, " ") != strings.Join(wantUp, " ") {
		t.Fatalf("up args mismatch:\n got: %v\nwant: %v", upArgs, wantUp)
	}
}

func TestLoadConfigRequiresDistinctEnvFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent-config.json")
	config := `{
		"environment": "dev",
		"compose": {
			"projectDirectory": "/app",
			"files": ["/app/docker-compose.yml"],
			"baseEnvFile": "/app/.env",
			"deployEnvFile": "/app/.env"
		},
		"services": [{"code":"wfo","composeService":"o24-wfo","containerName":"o24-wfo","imageRepository":"repo","imageEnvKey":"O24_WFO_IMAGE"}]
	}`
	if err := os.WriteFile(path, []byte(config), 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := loadConfig(path); err == nil {
		t.Fatal("expected loadConfig to reject identical baseEnvFile and deployEnvFile")
	}
}

// TestLoadConfigLegacyEnvFileFallback verifies that agent-config.json files
// written before baseEnvFile/deployEnvFile existed still load: the legacy
// envFile becomes DeployEnvFile, and BaseEnvFile stays empty (so compose
// keeps its old single-file behavior until the config is migrated).
func TestLoadConfigLegacyEnvFileFallback(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent-config.json")
	config := `{
		"environment": "dev",
		"compose": {
			"projectDirectory": "/app",
			"files": ["/app/docker-compose.yml"],
			"envFile": "/app/.env.deploy"
		},
		"services": [{"code":"wfo","composeService":"o24-wfo","containerName":"o24-wfo","imageRepository":"repo","imageEnvKey":"O24_WFO_IMAGE"}]
	}`
	if err := os.WriteFile(path, []byte(config), 0o640); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatalf("expected legacy envFile-only config to load, got error: %v", err)
	}
	if cfg.Compose.DeployEnvFile != "/app/.env.deploy" {
		t.Fatalf("expected DeployEnvFile to fall back to legacy envFile, got %q", cfg.Compose.DeployEnvFile)
	}
	if cfg.Compose.BaseEnvFile != "" {
		t.Fatalf("expected BaseEnvFile to stay empty in legacy fallback, got %q", cfg.Compose.BaseEnvFile)
	}
}

// TestLoadConfigPrefersNewFieldsOverLegacyEnvFile verifies the new fields win
// when a config sets both the new and legacy keys at once.
func TestLoadConfigPrefersNewFieldsOverLegacyEnvFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent-config.json")
	config := `{
		"environment": "dev",
		"compose": {
			"projectDirectory": "/app",
			"files": ["/app/docker-compose.yml"],
			"baseEnvFile": "/app/.env",
			"deployEnvFile": "/app/.env.deploy",
			"envFile": "/app/.env.deploy.old"
		},
		"services": [{"code":"wfo","composeService":"o24-wfo","containerName":"o24-wfo","imageRepository":"repo","imageEnvKey":"O24_WFO_IMAGE"}]
	}`
	if err := os.WriteFile(path, []byte(config), 0o640); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Compose.BaseEnvFile != "/app/.env" || cfg.Compose.DeployEnvFile != "/app/.env.deploy" {
		t.Fatalf("expected new fields to win over legacy envFile, got base=%q deploy=%q", cfg.Compose.BaseEnvFile, cfg.Compose.DeployEnvFile)
	}
}

// TestComposeArgsOmitsBaseEnvFileWhenUnset covers the legacy single-file mode
// (BaseEnvFile empty): only one --env-file flag should be present, pointing
// at DeployEnvFile, matching the agent's pre-two-file behavior exactly.
func TestComposeArgsOmitsBaseEnvFileWhenUnset(t *testing.T) {
	app := &App{
		cfg: Config{
			Compose: ComposeConfig{
				ProjectDirectory: "/app",
				Files:            []string{"/app/docker-compose.yml"},
				DeployEnvFile:    "/app/.env.deploy",
			},
		},
	}

	args := app.composeArgs("up", "-d", "--no-deps", "--force-recreate", "o24-wfo")

	envFileFlagCount := 0
	for _, arg := range args {
		if arg == "--env-file" {
			envFileFlagCount++
		}
	}
	if envFileFlagCount != 1 {
		t.Fatalf("expected exactly one --env-file flag in legacy mode, got %d in args: %v", envFileFlagCount, args)
	}
	found := false
	for i, arg := range args {
		if arg == "--env-file" && i+1 < len(args) && args[i+1] == "/app/.env.deploy" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected --env-file /app/.env.deploy in args: %v", args)
	}
}

func TestEnsureFileExists(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", ".env.deploy")

	if err := ensureFileExists(path); err != nil {
		t.Fatalf("expected file to be created, got error: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected file to exist after ensureFileExists: %v", err)
	}

	// Write real content, then call again: must not truncate an existing file.
	if err := os.WriteFile(path, []byte("O24_WFO_IMAGE=repo@sha256:abc\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := ensureFileExists(path); err != nil {
		t.Fatalf("unexpected error on already-existing file: %v", err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "O24_WFO_IMAGE=repo@sha256:abc\n" {
		t.Fatalf("expected ensureFileExists to leave existing content untouched, got: %q", string(content))
	}
}

func TestLastNonEmptyLine(t *testing.T) {
	cases := map[string]string{
		"":                    "",
		"\n\n":                "",
		"only line":           "only line",
		"first\nsecond\n":     "second",
		"first\nsecond\n\n\n": "second",
		"first\n  padded  \n": "padded",
	}
	for input, expected := range cases {
		if got := lastNonEmptyLine(input); got != expected {
			t.Fatalf("lastNonEmptyLine(%q) = %q, want %q", input, got, expected)
		}
	}
}

func TestExitCodeOf(t *testing.T) {
	if raw := os.Getenv("O24_TEST_HELPER_EXIT"); raw != "" {
		code, _ := strconv.Atoi(raw)
		os.Exit(code)
	}

	t.Setenv("O24_TEST_HELPER_EXIT", "3")
	cmd := exec.Command(os.Args[0], "-test.run=TestExitCodeOf")
	err := cmd.Run()
	if got := exitCodeOf(err); got != 3 {
		t.Fatalf("expected exit code 3, got %d (err=%v)", got, err)
	}

	if got := exitCodeOf(errors.New("not an exec error")); got != -1 {
		t.Fatalf("expected -1 for a non-ExitError, got %d", got)
	}
}

func TestComposeFailureMessage(t *testing.T) {
	err := errors.New("exit status 1")

	withOutput := composeFailureMessage("docker compose", 1, "Recreating container\nError response from daemon: no such image\n", err)
	if withOutput != "docker compose exited with code 1: Error response from daemon: no such image" {
		t.Fatalf("unexpected message: %q", withOutput)
	}
	if strings.Contains(withOutput, "exit status 1") {
		t.Fatalf("expected the real docker error, not the bare Go exec error text: %q", withOutput)
	}

	withoutOutput := composeFailureMessage("docker compose", 1, "", err)
	if withoutOutput != "docker compose exited with code 1: exit status 1" {
		t.Fatalf("unexpected fallback message: %q", withoutOutput)
	}

	unknownExit := composeFailureMessage("docker compose", -1, "", err)
	if unknownExit != "docker compose failed: exit status 1" {
		t.Fatalf("unexpected unknown-exit message: %q", unknownExit)
	}
}

func TestRunStreamedCommandCapturesOutputRealtime(t *testing.T) {
	if os.Getenv("O24_TEST_HELPER_STREAM") == "1" {
		fmt.Fprintln(os.Stdout, "hello from stdout")
		fmt.Fprintln(os.Stderr, "hello from stderr")
		os.Exit(7)
	}

	t.Setenv("O24_TEST_HELPER_STREAM", "1")
	op := newOperation("op-stream-test", "dev", "wfo", "deploy", "")

	output, err := runStreamedCommand(context.Background(), op, os.Args[0], "-test.run=TestRunStreamedCommandCapturesOutputRealtime")

	if !strings.Contains(output, "hello from stdout") || !strings.Contains(output, "hello from stderr") {
		t.Fatalf("expected both stdout and stderr lines in captured output, got: %q", output)
	}
	if got := exitCodeOf(err); got != 7 {
		t.Fatalf("expected exit code 7, got %d (err=%v)", got, err)
	}

	snap, _ := op.snapshot()
	messages := make([]string, 0, len(snap.Logs))
	for _, line := range snap.Logs {
		messages = append(messages, line.Message)
	}
	full := strings.Join(messages, "\n")
	if !strings.Contains(full, "hello from stdout") || !strings.Contains(full, "hello from stderr") {
		t.Fatalf("expected operation log to contain the streamed lines, got: %v", messages)
	}
	if len(messages) == 0 || !strings.HasPrefix(messages[0], "$ ") {
		t.Fatalf("expected the first log line to echo the command invocation, got: %v", messages)
	}
}

func TestOperationOrderAndOperationStore(t *testing.T) {
	app := &App{operations: map[string]*Operation{}}
	op := app.createOperation("dev", "wfo", "restart", "")
	if op.status != "running" {
		t.Fatalf("expected new operation to be running, got %s", op.status)
	}
	found, ok := app.getOperation(op.id)
	if !ok || found != op {
		t.Fatal("expected to retrieve the operation that was just created")
	}
	if _, ok := app.getOperation("missing-id"); ok {
		t.Fatal("expected missing operation lookup to fail")
	}
}
