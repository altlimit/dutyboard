// Command dutyboard provisions DutyBoard on altengine and works a board's duties on this machine.
package main

import (
	"os"

	"github.com/altlimit/dutyboard/cli/internal/app"
)

func main() { os.Exit(app.Main(os.Args[1:])) }
