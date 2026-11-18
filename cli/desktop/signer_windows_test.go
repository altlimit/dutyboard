//go:build windows

package main

import (
	"os"
	"strings"
	"testing"
)

// Run on a machine that has a signed DutyBoard and an unsigned build to hand:
//
//	DUTYBOARD_TEST_SIGNED=...\DutyBoard-Desktop.exe DUTYBOARD_TEST_UNSIGNED=...\dev.exe go test -run Signed .
//
// It is skipped everywhere else: a signature Windows trusts cannot be made up for a test.
func TestAnUpdateMustBeSignedByWhoeverSignedThisApp(t *testing.T) {
	signed, unsigned := os.Getenv("DUTYBOARD_TEST_SIGNED"), os.Getenv("DUTYBOARD_TEST_UNSIGNED")
	if signed == "" || unsigned == "" {
		t.Skip("needs a signed and an unsigned build")
	}
	if err := signedAlike(signed, signed); err != nil {
		t.Errorf("a signed app refused an update with its own signature: %v", err)
	}
	if err := signedAlike(signed, unsigned); err == nil || !strings.Contains(err.Error(), "not signed") {
		t.Errorf("a signed app took an unsigned update: %v", err)
	}
	if err := signedAlike(unsigned, unsigned); err != nil {
		t.Errorf("a development build refused an update: %v", err)
	}
	if err := signedAlike(unsigned, signed); err != nil {
		t.Errorf("a development build refused a signed update: %v", err)
	}
}
