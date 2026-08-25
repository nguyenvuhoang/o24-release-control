//go:build linux

package main

import (
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// This file backs the pure parsing/handler logic in hostmetrics.go with real
// reads from the host. It builds only on linux (the only platform the agent
// is ever deployed on — see Dockerfile) so `go build`/`go test` still work
// natively on a non-Linux dev machine via hostmetrics_other.go.
//
// CPU/RAM/load/uptime are read from /proc: Linux does not namespace
// /proc/loadavg, /proc/stat or /proc/meminfo by default (unlike hostname,
// which the container's own UTS namespace does isolate), so these reflect
// the real host even though the agent runs inside a container.

func readLoadAvg() (float64, float64, float64, error) {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, 0, 0, err
	}
	return parseLoadAvg(data)
}

func readCPUStatSample() (cpuStatSample, error) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return cpuStatSample{}, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "cpu ") {
			return parseCPUStatLine(line)
		}
	}
	return cpuStatSample{}, errors.New("cpu line not found in /proc/stat")
}

func readMemInfo() (HostMemMetrics, *HostSwapMetrics, error) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return HostMemMetrics{}, nil, err
	}
	mem, swap := buildMemMetrics(parseMemInfoFields(data))
	return mem, swap, nil
}

func readUptimeSeconds() (int64, error) {
	data, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0, errors.New("empty /proc/uptime")
	}
	seconds, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, err
	}
	return int64(seconds), nil
}

// statDiskUsage statfs's a path that is a bind-mount from the host (e.g. the
// compose project directory) — the agent's own container rootfs is NOT
// representative of host disk usage, so callers must pass a real host mount,
// never "/".
func statDiskUsage(path string) (used, total uint64, err error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, 0, err
	}
	blockSize := uint64(stat.Bsize)
	total = stat.Blocks * blockSize
	free := stat.Bavail * blockSize
	if free > total {
		free = total
	}
	return total - free, total, nil
}

// kernelRelease shells out to `uname -r` rather than syscall.Uname: the
// kernel version returned is identical either way (it's shared with the
// host, not namespaced), but Utsname's field type (int8 vs uint8) isn't
// consistent across every Linux architecture's Go ABI, while `uname` itself
// is guaranteed present (busybox/coreutils) and returns instantly.
func kernelRelease() string {
	out, err := exec.Command("uname", "-r").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// osPrettyName reads the agent container's own /etc/os-release — NOT the
// host's, since nothing mounts that in from the host (see docker-compose
// example). Best-effort only.
func osPrettyName() string {
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
		}
	}
	return ""
}
