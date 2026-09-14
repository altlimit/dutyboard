package runner

import "testing"

func TestActivity(t *testing.T) {
	dir := "/home/me/.dutyboard/worktrees/game/duty_1"
	cases := map[string]string{
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/home/me/.dutyboard/worktrees/game/duty_1/src/ui/pause.gd"}}]}}`: "Editing src/ui/pause.gd",
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"tools/run_tests.sh --all\necho done"}}]}}`:                         "Running `tools/run_tests.sh --all …`",
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"x","description":"Run the unit tests"}}]}}`:                          "Run the unit tests",
		`{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"},{"type":"tool_use","name":"mcp__dutyboard__duty_integrate","input":{}}]}}`:           "Integrating its work",
		`{"type":"assistant","message":{"content":[{"type":"text","text":"just talking"}]}}`:                                                                                "",
		`{"type":"result","result":"done"}`: "",
	}
	for line, want := range cases {
		if got := Activity([]byte(line), dir); got != want {
			t.Errorf("Activity(%s) = %q, want %q", line, got, want)
		}
	}
}

func TestLimitIsRead(t *testing.T) {
	var o Outcome
	readEvent([]byte(`{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1789410000}}`), &o)
	if !o.Limited || o.ResetsAt.Unix() != 1789410000 {
		t.Fatalf("a rejected rate limit event should mark the session limited: %+v", o)
	}
	o = Outcome{}
	readEvent([]byte(`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1789410000}}`), &o)
	if o.Limited {
		t.Fatal("an allowed rate limit event is not a limit")
	}
}
