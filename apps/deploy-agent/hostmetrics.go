package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// HostMetrics is the response body for GET /api/host/metrics — a lightweight
// snapshot of the machine the agent runs on, so Control Center can show
// whether a server has enough headroom before a build/deploy/promote instead
// of becoming a full monitoring platform.
//
// CPU/RAM/load/uptime/kernel reflect the REAL underlying host even though the
// agent itself runs inside a container: Linux does not namespace
// /proc/loadavg, /proc/stat or /proc/meminfo, and `uname -r` reports the one
// kernel shared with the host. Hostname and OS pretty-name are NOT
// host-namespaced — they describe the agent's own container unless Hostname
// is set explicitly in agent-config.json (see Config.Hostname).
type HostMetrics struct {
	Hostname             string              `json:"hostname"`
	CPU                  HostCPUMetrics      `json:"cpu"`
	Memory               HostMemMetrics      `json:"memory"`
	Swap                 *HostSwapMetrics    `json:"swap,omitempty"`
	Disk                 HostDiskMetrics     `json:"disk"`
	DockerDiskUsageBytes *uint64             `json:"dockerDiskUsageBytes,omitempty"`
	Containers            HostContainerCounts `json:"containers"`
	UptimeSeconds         int64               `json:"uptimeSeconds"`
	OS                    string              `json:"os,omitempty"`
	Kernel                string              `json:"kernel,omitempty"`
	SampledAt             time.Time           `json:"sampledAt"`
}

type HostCPUMetrics struct {
	// UsagePercent is omitted on the very first sample after the agent
	// starts — it needs a previous /proc/stat snapshot to compute a delta
	// against, and none exists yet.
	UsagePercent *float64 `json:"usagePercent,omitempty"`
	Cores        int      `json:"cores"`
	Load1        float64  `json:"load1"`
	Load5        float64  `json:"load5"`
	Load15       float64  `json:"load15"`
}

type HostMemMetrics struct {
	UsedBytes    uint64  `json:"usedBytes"`
	TotalBytes   uint64  `json:"totalBytes"`
	UsagePercent float64 `json:"usagePercent"`
}

type HostSwapMetrics struct {
	UsedBytes  uint64 `json:"usedBytes"`
	TotalBytes uint64 `json:"totalBytes"`
}

type HostDiskMetrics struct {
	UsedBytes    uint64  `json:"usedBytes"`
	TotalBytes   uint64  `json:"totalBytes"`
	UsagePercent float64 `json:"usagePercent"`
}

type HostContainerCounts struct {
	Running    int `json:"running"`
	Stopped    int `json:"stopped"`
	Restarting int `json:"restarting"`
}

// cpuStatSample is the minimal state needed to compute CPU usage% as a delta
// between two /proc/stat reads — idle/total jiffies since boot. Kept on App
// between requests so usage% never requires sleeping inside the request.
type cpuStatSample struct {
	idle  uint64
	total uint64
}

// handleHostMetrics always returns 200 with whatever it could sample — a
// single unavailable metric (e.g. docker system df timing out) must never
// fail the whole response, since the dashboard would rather show partial
// host health than none at all.
func (a *App) handleHostMetrics(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	metrics := HostMetrics{
		Hostname:  a.hostname(),
		SampledAt: time.Now().UTC(),
	}

	metrics.CPU.Cores = runtime.NumCPU()
	if load1, load5, load15, err := readLoadAvg(); err == nil {
		metrics.CPU.Load1, metrics.CPU.Load5, metrics.CPU.Load15 = load1, load5, load15
	} else {
		log.Printf("host metrics: read load average: %v", err)
	}
	if sample, err := readCPUStatSample(); err == nil {
		if pct, ok := a.cpuUsagePercent(sample); ok {
			metrics.CPU.UsagePercent = &pct
		}
	} else {
		log.Printf("host metrics: read cpu stat: %v", err)
	}

	if mem, swap, err := readMemInfo(); err == nil {
		metrics.Memory = mem
		metrics.Swap = swap
	} else {
		log.Printf("host metrics: read meminfo: %v", err)
	}

	diskPath := strings.TrimSpace(a.cfg.HostDiskPath)
	if diskPath == "" {
		diskPath = a.cfg.Compose.ProjectDirectory
	}
	if used, total, err := statDiskUsage(diskPath); err == nil && total > 0 {
		metrics.Disk = HostDiskMetrics{UsedBytes: used, TotalBytes: total, UsagePercent: percentOf(used, total)}
	} else if err != nil {
		log.Printf("host metrics: statfs %s: %v", diskPath, err)
	}

	if uptime, err := readUptimeSeconds(); err == nil {
		metrics.UptimeSeconds = uptime
	} else {
		log.Printf("host metrics: read uptime: %v", err)
	}

	metrics.Kernel = kernelRelease()
	metrics.OS = osPrettyName()
	metrics.Containers = a.countContainerStates(ctx)
	if used, ok := a.dockerDiskUsage(ctx); ok {
		metrics.DockerDiskUsageBytes = &used
	}

	writeJSON(w, http.StatusOK, metrics)
}

func (a *App) hostname() string {
	if strings.TrimSpace(a.cfg.Hostname) != "" {
		return a.cfg.Hostname
	}
	return a.cfg.Environment
}

// cpuUsagePercent computes usage% against the last sample stored on App,
// updating it for next time regardless of whether a percentage could be
// produced (so a single bad sample never blocks the next request's delta).
func (a *App) cpuUsagePercent(sample cpuStatSample) (float64, bool) {
	a.hostCPUMu.Lock()
	defer a.hostCPUMu.Unlock()
	prev := a.hostCPULastSample
	hasPrev := a.hostCPUHasSample
	a.hostCPULastSample = sample
	a.hostCPUHasSample = true
	if !hasPrev || sample.total <= prev.total {
		return 0, false
	}
	return computeCPUPercent(prev, sample), true
}

// computeCPUPercent is a pure function of two /proc/stat "cpu " samples —
// unit-tested independently of any real /proc access.
func computeCPUPercent(prev, cur cpuStatSample) float64 {
	totalDelta := float64(cur.total - prev.total)
	if totalDelta <= 0 {
		return 0
	}
	idleDelta := float64(cur.idle - prev.idle)
	pct := (1 - idleDelta/totalDelta) * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return roundTo1(pct)
}

// parseCPUStatLine parses the aggregate "cpu  <user> <nice> <system> <idle>
// <iowait> <irq> <softirq> <steal> ..." line from /proc/stat. iowait is
// folded into "idle" and irq/softirq/steal into "busy", matching the
// standard top/htop CPU% convention.
func parseCPUStatLine(line string) (cpuStatSample, error) {
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return cpuStatSample{}, fmt.Errorf("unexpected /proc/stat cpu line: %q", line)
	}
	values := make([]uint64, len(fields)-1)
	for i, raw := range fields[1:] {
		v, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			return cpuStatSample{}, fmt.Errorf("parse /proc/stat field %q: %w", raw, err)
		}
		values[i] = v
	}
	get := func(i int) uint64 {
		if i < len(values) {
			return values[i]
		}
		return 0
	}
	user, nice, system, idle, iowait, irq, softirq, steal := get(0), get(1), get(2), get(3), get(4), get(5), get(6), get(7)
	idleAll := idle + iowait
	nonIdle := user + nice + system + irq + softirq + steal
	return cpuStatSample{idle: idleAll, total: idleAll + nonIdle}, nil
}

// parseLoadAvg parses the first three fields of /proc/loadavg.
func parseLoadAvg(data []byte) (load1, load5, load15 float64, err error) {
	fields := strings.Fields(string(data))
	if len(fields) < 3 {
		return 0, 0, 0, fmt.Errorf("unexpected /proc/loadavg content: %q", string(data))
	}
	if load1, err = strconv.ParseFloat(fields[0], 64); err != nil {
		return 0, 0, 0, err
	}
	if load5, err = strconv.ParseFloat(fields[1], 64); err != nil {
		return 0, 0, 0, err
	}
	if load15, err = strconv.ParseFloat(fields[2], 64); err != nil {
		return 0, 0, 0, err
	}
	return load1, load5, load15, nil
}

// parseMemInfoFields parses /proc/meminfo into a key -> value(kB) map,
// ignoring lines it doesn't recognize the shape of.
func parseMemInfoFields(data []byte) map[string]uint64 {
	fields := map[string]uint64{}
	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		key := strings.TrimSuffix(parts[0], ":")
		value, err := strconv.ParseUint(parts[1], 10, 64)
		if err != nil {
			continue
		}
		fields[key] = value
	}
	return fields
}

// buildMemMetrics turns parsed /proc/meminfo fields (kB) into byte-based
// metrics. Prefers MemAvailable (kernel's own "usable without swapping"
// estimate); falls back to MemTotal-MemFree only if MemAvailable is absent
// (very old kernels).
func buildMemMetrics(fields map[string]uint64) (HostMemMetrics, *HostSwapMetrics) {
	totalKB := fields["MemTotal"]
	var usedKB uint64
	if availKB, ok := fields["MemAvailable"]; ok && availKB <= totalKB {
		usedKB = totalKB - availKB
	} else if freeKB, ok := fields["MemFree"]; ok && freeKB <= totalKB {
		usedKB = totalKB - freeKB
	}
	mem := HostMemMetrics{
		UsedBytes:    usedKB * 1024,
		TotalBytes:   totalKB * 1024,
		UsagePercent: percentOf(usedKB, totalKB),
	}

	var swap *HostSwapMetrics
	if swapTotalKB, ok := fields["SwapTotal"]; ok {
		swapFreeKB := fields["SwapFree"]
		var swapUsedKB uint64
		if swapFreeKB <= swapTotalKB {
			swapUsedKB = swapTotalKB - swapFreeKB
		}
		swap = &HostSwapMetrics{UsedBytes: swapUsedKB * 1024, TotalBytes: swapTotalKB * 1024}
	}
	return mem, swap
}

func percentOf(used, total uint64) float64 {
	if total == 0 {
		return 0
	}
	pct := float64(used) / float64(total) * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return roundTo1(pct)
}

func roundTo1(v float64) float64 {
	return math.Round(v*10) / 10
}

// parseContainerStates classifies the newline-separated output of
// `docker ps -a --format {{.State}}` into Running/Stopped/Restarting —
// everything that isn't "running" or "restarting" (exited, created, paused,
// dead) counts as Stopped.
func parseContainerStates(output string) HostContainerCounts {
	var counts HostContainerCounts
	for _, line := range strings.Split(output, "\n") {
		state := strings.ToLower(strings.TrimSpace(line))
		if state == "" {
			continue
		}
		switch state {
		case "running":
			counts.Running++
		case "restarting":
			counts.Restarting++
		default:
			counts.Stopped++
		}
	}
	return counts
}

func (a *App) countContainerStates(ctx context.Context) HostContainerCounts {
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	output, err := runCommand(cctx, "docker", "ps", "-a", "--format", "{{.State}}")
	if err != nil {
		log.Printf("host metrics: docker ps: %v", err)
		return HostContainerCounts{}
	}
	return parseContainerStates(output)
}

type dockerDFRow struct {
	Size string `json:"Size"`
}

var humanSizePattern = regexp.MustCompile(`^([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]*)$`)

// parseHumanSize converts a `docker system df` size string ("1.2GB", "0B",
// "512kB") into bytes. Returns ok=false for anything it doesn't recognize
// rather than guessing.
func parseHumanSize(value string) (uint64, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, false
	}
	matches := humanSizePattern.FindStringSubmatch(value)
	if matches == nil {
		return 0, false
	}
	num, err := strconv.ParseFloat(matches[1], 64)
	if err != nil {
		return 0, false
	}
	var multiplier float64
	switch strings.ToLower(matches[2]) {
	case "", "b":
		multiplier = 1
	case "kb", "kib":
		multiplier = 1 << 10
	case "mb", "mib":
		multiplier = 1 << 20
	case "gb", "gib":
		multiplier = 1 << 30
	case "tb", "tib":
		multiplier = 1 << 40
	default:
		return 0, false
	}
	return uint64(num * multiplier), true
}

// parseDockerDiskUsage sums the Size of every row printed by
// `docker system df --format {{json .}}` (one JSON object per line: Images,
// Containers, Local Volumes, Build Cache). Any row it can't parse is simply
// skipped rather than failing the whole metric — this is best-effort.
func parseDockerDiskUsage(output string) (uint64, bool) {
	var total uint64
	found := false
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var row dockerDFRow
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			continue
		}
		if bytes, ok := parseHumanSize(row.Size); ok {
			total += bytes
			found = true
		}
	}
	return total, found
}

func (a *App) dockerDiskUsage(ctx context.Context) (uint64, bool) {
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	output, err := runCommand(cctx, "docker", "system", "df", "--format", "{{json .}}")
	if err != nil {
		log.Printf("host metrics: docker system df: %v", err)
		return 0, false
	}
	return parseDockerDiskUsage(output)
}
