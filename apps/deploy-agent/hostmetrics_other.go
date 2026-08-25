//go:build !linux

package main

import "errors"

// Stub implementation for non-Linux dev machines so `go build`/`go test`
// still work natively outside the Linux container the agent actually runs
// in (see Dockerfile, which always cross-compiles GOOS=linux). Every value
// is simply "unavailable" — handleHostMetrics already treats each metric as
// optional and omits/logs on error rather than failing the request.
var errHostMetricsUnavailable = errors.New("host metrics are only available when running on Linux")

func readLoadAvg() (float64, float64, float64, error) {
	return 0, 0, 0, errHostMetricsUnavailable
}

func readCPUStatSample() (cpuStatSample, error) {
	return cpuStatSample{}, errHostMetricsUnavailable
}

func readMemInfo() (HostMemMetrics, *HostSwapMetrics, error) {
	return HostMemMetrics{}, nil, errHostMetricsUnavailable
}

func readUptimeSeconds() (int64, error) {
	return 0, errHostMetricsUnavailable
}

func statDiskUsage(path string) (used, total uint64, err error) {
	return 0, 0, errHostMetricsUnavailable
}

func kernelRelease() string {
	return ""
}

func osPrettyName() string {
	return ""
}
