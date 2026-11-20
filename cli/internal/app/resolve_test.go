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

func TestAConsoleDeployedFromTheLinkLeadsToItsFunction(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/board/health" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, `{"ok":true,"service":"dutyboard","version":"2.37.0","machines":true,"app":"dutyboard"}`)
	}))
	defer api.Close()
	console := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/altengine.json":
			// As altengine generates it from the manifest's runtimeConfig.
			fmt.Fprintf(w, `{"app":"dutyboard","version":"2.37.0","api":"https://api.altengine.net","instances":{
				"datastore":{"service":"datastore","name":"dutyboard","id":"d1","url":null},
				"functions":{"service":"functions","name":"dutyboard","id":"f1","url":%q}}}`, api.URL+"/")
		case "/config.js":
			// The console's own, which says nothing: a manifest deploy writes none.
			fmt.Fprint(w, "window.DUTYBOARD_CONFIG = null;\n")
		default:
			fmt.Fprint(w, "<!doctype html><title>DutyBoard</title>")
		}
	}))
	defer console.Close()

	for _, given := range []string{console.URL, console.URL + "/#/machines"} {
		got, err := ResolveBoard(context.Background(), given)
		if err != nil || got != api.URL+"/board" {
			t.Errorf("ResolveBoard(%q) = %q, %v; want the function under the functions instance", given, got, err)
		}
	}
}

func TestTheDeployLinkNamesTheManifestAndWhatItUpgrades(t *testing.T) {
	t.Setenv("DUTYBOARD_DEPLOY_BASE", "")
	t.Setenv("ALTENGINE_CONSOLE_URL", "")
	fresh := DeployLink("")
	if fresh != "https://console.altengine.net/deploy?manifest=https%3A%2F%2Fwww.dutyboard.com%2Fdeploy%2Flatest%2Faltengine.json" {
		t.Errorf("a new deployment's link = %s", fresh)
	}
	if up := DeployLink("dutyboard-acme"); up != fresh+"&name=dutyboard-acme" {
		t.Errorf("an upgrade's link = %s", up)
	}
	t.Setenv("DUTYBOARD_DEPLOY_BASE", "http://localhost:8080/deploy")
	t.Setenv("ALTENGINE_CONSOLE_URL", "http://localhost:5174/")
	if got := DeployLink(""); got != "http://localhost:5174/deploy?manifest=http%3A%2F%2Flocalhost%3A8080%2Fdeploy%2Flatest%2Faltengine.json" {
		t.Errorf("an overridden link = %s", got)
	}
}
