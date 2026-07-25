package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDiagnosticsMuxExposesRuntimeAndHeapProfile(t *testing.T) {
	handler := diagnosticsMux()

	runtimeRequest := httptest.NewRequest(http.MethodGet, "/debug/runtime", nil)
	runtimeResponse := httptest.NewRecorder()
	handler.ServeHTTP(runtimeResponse, runtimeRequest)
	if runtimeResponse.Code != http.StatusOK {
		t.Fatalf("runtime status = %d", runtimeResponse.Code)
	}
	var body struct {
		Goroutines int `json:"goroutines"`
	}
	if err := json.Unmarshal(runtimeResponse.Body.Bytes(), &body); err != nil {
		t.Fatalf("runtime JSON: %v", err)
	}
	if body.Goroutines < 1 {
		t.Fatalf("goroutines = %d", body.Goroutines)
	}

	heapRequest := httptest.NewRequest(http.MethodGet, "/debug/pprof/heap?debug=1", nil)
	heapResponse := httptest.NewRecorder()
	handler.ServeHTTP(heapResponse, heapRequest)
	if heapResponse.Code != http.StatusOK {
		t.Fatalf("heap status = %d", heapResponse.Code)
	}
	if heapResponse.Body.Len() == 0 {
		t.Fatal("heap profile was empty")
	}
}
