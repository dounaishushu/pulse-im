package main

import (
	"math"
	"testing"
)

func TestLegacyPositiveIDCellUnsignedMySQLID(t *testing.T) {
	for _, input := range []any{uint64(85045), int64(85045), []byte("85045")} {
		got, err := legacyPositiveIDCell(input)
		if err != nil || got != 85045 {
			t.Fatalf("legacyPositiveIDCell(%T) = %d, %v", input, got, err)
		}
	}
	for _, input := range []any{uint64(0), uint64(math.MaxInt64) + 1, []byte("bad")} {
		if _, err := legacyPositiveIDCell(input); err == nil {
			t.Fatalf("legacyPositiveIDCell(%v) accepted invalid ID", input)
		}
	}
}
