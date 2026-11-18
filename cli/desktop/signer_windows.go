//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// sameSigner checks that the file at path is signed by whoever signed the app that is running.
//
// A checksum from the same place as the download proves the download is intact; it cannot prove the
// release is ours. Windows already knows who signed this app, so an update has to carry a valid
// signature from the same publisher, or it is not installed. A development build is not signed, has
// nobody to compare with, and takes what it is given — which is also what lets it be tested.
//
// Windows' own verifier does the work, through PowerShell: it is on every Windows this runs on, and
// it is the same check a person makes in a file's Properties.
func sameSigner(path string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	return signedAlike(self, path)
}

// signedAlike is sameSigner for any two files: path must be signed by whoever signed self.
func signedAlike(self, path string) error {
	const script = `$ErrorActionPreference='Stop';` +
		`$a=Get-AuthenticodeSignature -LiteralPath $env:DUTYBOARD_SIGNED_A;` +
		`$b=Get-AuthenticodeSignature -LiteralPath $env:DUTYBOARD_SIGNED_B;` +
		`@{a="$($a.Status)";aBy="$($a.SignerCertificate.Subject)";b="$($b.Status)";bBy="$($b.SignerCertificate.Subject)"}|ConvertTo-Json -Compress`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.Env = append(os.Environ(), "DUTYBOARD_SIGNED_A="+self, "DUTYBOARD_SIGNED_B="+path)
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("its signature could not be checked: %w", err)
	}
	var got struct{ A, ABy, B, BBy string }
	if i := strings.IndexByte(string(out), '{'); i < 0 || json.Unmarshal(out[i:], &got) != nil {
		return errors.New("its signature could not be checked")
	}
	if got.A != "Valid" {
		return nil // this app is not signed: a development build
	}
	if got.B != "Valid" {
		return fmt.Errorf("it is not signed (%s)", got.B)
	}
	if got.BBy != got.ABy {
		return fmt.Errorf("it is signed by %q, and this app by %q", got.BBy, got.ABy)
	}
	return nil
}
