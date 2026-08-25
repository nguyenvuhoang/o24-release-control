package main

import "testing"

func TestParseLoadAvg(t *testing.T) {
	load1, load5, load15, err := parseLoadAvg([]byte("1.42 1.18 0.96 2/456 12345\n"))
	if err != nil {
		t.Fatal(err)
	}
	if load1 != 1.42 || load5 != 1.18 || load15 != 0.96 {
		t.Fatalf("unexpected loads: %v %v %v", load1, load5, load15)
	}
}

func TestParseLoadAvgInvalid(t *testing.T) {
	if _, _, _, err := parseLoadAvg([]byte("garbage")); err == nil {
		t.Fatal("expected error for malformed /proc/loadavg content")
	}
}

func TestParseCPUStatLine(t *testing.T) {
	sample, err := parseCPUStatLine("cpu  100 0 50 800 20 0 5 0 0 0")
	if err != nil {
		t.Fatal(err)
	}
	// idleAll = idle(800) + iowait(20) = 820
	// nonIdle = user(100) + nice(0) + system(50) + irq(0) + softirq(5) + steal(0) = 155
	if sample.idle != 820 {
		t.Fatalf("unexpected idle: %d", sample.idle)
	}
	if sample.total != 975 {
		t.Fatalf("unexpected total: %d", sample.total)
	}
}

func TestParseCPUStatLineRejectsWrongPrefix(t *testing.T) {
	if _, err := parseCPUStatLine("cpu0 100 0 50 800 20 0 5 0"); err == nil {
		t.Fatal("expected error for per-core line, not the aggregate 'cpu ' line")
	}
}

func TestComputeCPUPercent(t *testing.T) {
	prev := cpuStatSample{idle: 800, total: 1000}
	cur := cpuStatSample{idle: 850, total: 1200} // +200 total, +50 idle -> 150 busy -> 75%
	pct := computeCPUPercent(prev, cur)
	if pct != 75 {
		t.Fatalf("expected 75%%, got %v", pct)
	}
}

func TestComputeCPUPercentClampsToRange(t *testing.T) {
	// No time elapsed (counters didn't move) must never divide by zero or go negative.
	if pct := computeCPUPercent(cpuStatSample{idle: 10, total: 10}, cpuStatSample{idle: 10, total: 10}); pct != 0 {
		t.Fatalf("expected 0 for a zero delta, got %v", pct)
	}
}

func TestParseMemInfoFieldsAndBuildMemMetrics(t *testing.T) {
	data := []byte("MemTotal:       16777216 kB\nMemFree:         2097152 kB\nMemAvailable:    8388608 kB\nSwapTotal:       2097152 kB\nSwapFree:        2097152 kB\n")
	fields := parseMemInfoFields(data)
	mem, swap := buildMemMetrics(fields)

	wantTotal := uint64(16777216 * 1024)
	wantUsed := uint64((16777216 - 8388608) * 1024) // uses MemAvailable, not MemFree
	if mem.TotalBytes != wantTotal || mem.UsedBytes != wantUsed {
		t.Fatalf("unexpected mem metrics: %+v", mem)
	}
	if mem.UsagePercent != 50 {
		t.Fatalf("expected 50%% used, got %v", mem.UsagePercent)
	}
	if swap == nil {
		t.Fatal("expected swap metrics to be present")
	}
	if swap.TotalBytes != uint64(2097152*1024) || swap.UsedBytes != 0 {
		t.Fatalf("unexpected swap metrics: %+v", swap)
	}
}

func TestBuildMemMetricsWithoutSwap(t *testing.T) {
	fields := parseMemInfoFields([]byte("MemTotal: 1000 kB\nMemAvailable: 400 kB\n"))
	_, swap := buildMemMetrics(fields)
	if swap != nil {
		t.Fatalf("expected nil swap when SwapTotal is absent, got %+v", swap)
	}
}

func TestPercentOfHandlesZeroTotal(t *testing.T) {
	if pct := percentOf(5, 0); pct != 0 {
		t.Fatalf("expected 0 for zero total, got %v", pct)
	}
}

func TestParseContainerStates(t *testing.T) {
	counts := parseContainerStates("running\nrunning\nexited\nrestarting\ncreated\npaused\n")
	if counts.Running != 2 || counts.Restarting != 1 || counts.Stopped != 3 {
		t.Fatalf("unexpected counts: %+v", counts)
	}
}

func TestParseContainerStatesEmpty(t *testing.T) {
	counts := parseContainerStates("")
	if counts.Running != 0 || counts.Stopped != 0 || counts.Restarting != 0 {
		t.Fatalf("expected all-zero counts, got %+v", counts)
	}
}

func TestParseHumanSize(t *testing.T) {
	var gb float64 = 1 << 30
	cases := map[string]uint64{
		"0B":      0,
		"512B":    512,
		"1.2GB":   uint64(1.2 * gb),
		"500MB":   500 * (1 << 20),
		"2kB":     2 * (1 << 10),
		"invalid": 0,
	}
	for input, want := range cases {
		got, ok := parseHumanSize(input)
		if input == "invalid" {
			if ok {
				t.Fatalf("expected parseHumanSize(%q) to fail", input)
			}
			continue
		}
		if !ok || got != want {
			t.Fatalf("parseHumanSize(%q) = %d, %v; want %d", input, got, ok, want)
		}
	}
}

func TestParseDockerDiskUsage(t *testing.T) {
	output := `{"Type":"Images","Size":"1.2GB"}
{"Type":"Containers","Size":"300MB"}
{"Type":"Local Volumes","Size":"0B"}
not-json
{"Type":"Build Cache","Size":"badvalue"}`
	total, ok := parseDockerDiskUsage(output)
	if !ok {
		t.Fatal("expected at least one parseable row")
	}
	var gb float64 = 1 << 30
	want := uint64(1.2*gb) + 300*(1<<20)
	if total != want {
		t.Fatalf("unexpected total: got %d want %d", total, want)
	}
}

func TestParseDockerDiskUsageAllUnparseable(t *testing.T) {
	if _, ok := parseDockerDiskUsage("garbage\nnot json either"); ok {
		t.Fatal("expected ok=false when nothing could be parsed")
	}
}
