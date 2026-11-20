package daemon

import (
	"strings"
	"testing"

	"github.com/altlimit/dutyboard/cli/internal/board"
)

func shopBoard() board.BoardView {
	return board.BoardView{ProjectID: "shop", Profile: &board.Profile{MCPServers: []board.MCPServer{
		{Name: "store", URL: "https://example.com/mcp", Secrets: []string{"Authorization"}},
		{Name: "mail", Command: "mail-mcp", Secrets: []string{"MAIL_TOKEN"}},
	}}}
}

// Only what a board this machine works names is stored; the console cannot write anything else into
// the keyring.
func TestSecretsToStoreKeepsOnlyWhatBoardsName(t *testing.T) {
	links := []board.BoardView{shopBoard(), {ProjectID: "no-profile"}}

	got, err := secretsToStore(links, []byte(`{"v":1,"secrets":[
		{"board":"shop","server":"store","name":"Authorization","value":"Bearer abc"},
		{"board":"shop","server":"mail","name":"MAIL_TOKEN","value":"tok"}]}`))
	if err != nil || len(got) != 2 || got[0].Value != "Bearer abc" {
		t.Fatalf("secretsToStore = %+v, %v", got, err)
	}
	if said := describeStored(got); said != "stored 2 MCP secrets for shop" || strings.Contains(said, "abc") {
		t.Errorf("describeStored = %q", said)
	}

	for name, tc := range map[string]struct{ body, want string }{
		"another board":    {`{"v":1,"secrets":[{"board":"other","server":"store","name":"Authorization","value":"x"}]}`, "no board this machine works names other/store Authorization"},
		"an unnamed name":  {`{"v":1,"secrets":[{"board":"shop","server":"store","name":"X-Other","value":"x"}]}`, "names shop/store X-Other"},
		"an empty value":   {`{"v":1,"secrets":[{"board":"shop","server":"mail","name":"MAIL_TOKEN","value":""}]}`, "is empty"},
		"a pasted file":    {`{"v":1,"secrets":[{"board":"shop","server":"mail","name":"MAIL_TOKEN","value":"a\nb"}]}`, "not a single value"},
		"nothing":          {`{"v":1,"secrets":[]}`, "no secrets were sent"},
		"a newer envelope": {`{"v":2,"secrets":[]}`, "update it"},
		"not json":         {`Bearer abc`, "update it"},
	} {
		if _, err := secretsToStore(links, []byte(tc.body)); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v, want it to say %q", name, err, tc.want)
		}
	}
}
