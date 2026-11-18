package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAConsoleAddressLeadsToTheAPIItWasDeployedWith(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/board/health" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, `{"ok":true,"service":"dutyboard","version":"2.30.0","machines":true}`)
	}))
	defer api.Close()
	console := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/config.js":
			// As provision writes it.
			fmt.Fprintf(w, "// Written by the dutyboard provisioner: where this console points.\nwindow.DUTYBOARD_CONFIG = {\n  \"auth\": \"a\",\n  \"api\": %q,\n  \"fn\": \"board\"\n};\n", api.URL+"/board")
		case "/dev/config.js":
			fmt.Fprint(w, "window.DUTYBOARD_CONFIG = null;\n")
		default:
			fmt.Fprint(w, "<!doctype html><title>DutyBoard</title>")
		}
	}))
	defer console.Close()
	ctx := context.Background()

	for _, given := range []string{
		api.URL + "/board",
		api.URL + "/board/",
		console.URL,
		console.URL + "/",
		console.URL + "/#/machines",
		console.URL + "/index.html#/b/some-board",
	} {
		got, err := ResolveBoard(ctx, given)
		if err != nil || got != api.URL+"/board" {
			t.Errorf("ResolveBoard(%q) = %q, %v; want the API address", given, got, err)
		}
	}

	// A console that names no deployment, and an address that is neither.
	for _, given := range []string{console.URL + "/dev/", api.URL + "/nothing", "not an address"} {
		if got, err := ResolveBoard(ctx, given); err == nil {
			t.Errorf("ResolveBoard(%q) = %q; want an error", given, got)
		}
	}
}
