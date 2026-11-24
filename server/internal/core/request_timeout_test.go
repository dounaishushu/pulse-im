package core

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestIncompleteJSONReturnsTimeoutWithoutLosingResponseOrCapacity(t *testing.T) {
	for _, prefix := range []string{`{"value":`, `{"value":1}`} {
		t.Run(prefix, func(t *testing.T) {
			api := &API{slots: make(chan struct{}, 1)}
			handler := api.wrapTimed(false, 100*time.Millisecond, func(w http.ResponseWriter, r *http.Request, _ Identity) error {
				var in struct {
					Value int `json:"value"`
				}
				if err := decode(w, r, &in); err != nil {
					return err
				}
				w.WriteHeader(http.StatusNoContent)
				return nil
			})
			server := httptest.NewUnstartedServer(handler)
			server.Config.ReadTimeout = time.Second
			server.Config.WriteTimeout = time.Second
			server.Start()
			defer server.Close()
			conn, err := net.DialTimeout("tcp", strings.TrimPrefix(server.URL, "http://"), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
			start := time.Now()
			_, err = fmt.Fprintf(conn, "POST /slow-json HTTP/1.1\r\nHost: test\r\nContent-Length: 128\r\nContent-Type: application/json\r\n\r\n%s", prefix)
			if err != nil {
				t.Fatal(err)
			}
			response, err := http.ReadResponse(bufio.NewReader(conn), nil)
			if err != nil {
				t.Fatalf("slow request lost its HTTP response: %v", err)
			}
			defer response.Body.Close()
			var result struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if err = json.NewDecoder(response.Body).Decode(&result); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusRequestTimeout || result.Error.Code != "request_timeout" || time.Since(start) >= time.Second {
				t.Fatalf("slow JSON returned %d/%s after %s", response.StatusCode, result.Error.Code, time.Since(start))
			}
			fast, err := http.Post(server.URL+"/fast-json", "application/json", strings.NewReader(`{"value":1}`))
			if err != nil {
				t.Fatal(err)
			}
			defer fast.Body.Close()
			_, _ = io.Copy(io.Discard, fast.Body)
			if fast.StatusCode != http.StatusNoContent || len(api.slots) != 0 {
				t.Fatal("slow body kept the request slot or affected subsequent traffic")
			}
		})
	}
}

func TestHTTP2SlowJSONDoesNotBlockOtherStreams(t *testing.T) {
	api := &API{slots: make(chan struct{}, 2)}
	handler := api.wrapTimed(false, 100*time.Millisecond, func(w http.ResponseWriter, r *http.Request, _ Identity) error {
		var in map[string]int
		if err := decode(w, r, &in); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	})
	server := httptest.NewUnstartedServer(handler)
	server.EnableHTTP2 = true
	server.StartTLS()
	defer server.Close()
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	go func() { _, _ = writer.Write([]byte(`{"value":`)) }()
	request, _ := http.NewRequest(http.MethodPost, server.URL, reader)
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.ProtoMajor != 2 || response.StatusCode != http.StatusRequestTimeout {
		t.Fatalf("HTTP/2 slow upload returned %s %d", response.Proto, response.StatusCode)
	}
	fast, err := server.Client().Post(server.URL, "application/json", strings.NewReader(`{"value":1}`))
	if err != nil {
		t.Fatal(err)
	}
	defer fast.Body.Close()
	if fast.ProtoMajor != 2 || fast.StatusCode != http.StatusNoContent {
		t.Fatal("timed out stream affected the next HTTP/2 request")
	}
}
