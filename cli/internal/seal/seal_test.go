package seal

import (
	"crypto/ecdh"
	"crypto/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestSealOpenRoundTrip(t *testing.T) {
	t.Setenv("DUTYBOARD_HOME", t.TempDir())
	t.Setenv("DUTYBOARD_NO_KEYRING", "1")

	public, err := PublicKey()
	if err != nil {
		t.Fatal(err)
	}
	// 65 bytes of uncompressed point, unpadded base64url: what the board's validation expects.
	if len(public) != 87 {
		t.Fatalf("public key is %d characters, want 87", len(public))
	}
	again, _ := PublicKey()
	if again != public {
		t.Fatal("the machine's key changed between two reads")
	}

	envelope, err := Seal(public, []byte(`{"v":1,"secrets":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(envelope, "secrets") {
		t.Fatal("the envelope carries its plaintext")
	}
	plain, err := Open(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if string(plain) != `{"v":1,"secrets":[]}` {
		t.Fatalf("opened %q", plain)
	}
}

func TestOpenRefusesWhatWasNotSealedForThisKey(t *testing.T) {
	mine, _ := ecdh.P256().GenerateKey(rand.Reader)
	other, _ := ecdh.P256().GenerateKey(rand.Reader)
	envelope, err := Seal(b64.EncodeToString(other.PublicKey().Bytes()), []byte("token"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := open(mine, envelope); err == nil || !strings.Contains(err.Error(), "different key") {
		t.Fatalf("opening another machine's envelope: %v", err)
	}
	if plain, err := open(other, envelope); err != nil || string(plain) != "token" {
		t.Fatalf("the right key: %q, %v", plain, err)
	}

	parts := strings.Split(envelope, ".")
	tampered := strings.Join([]string{parts[0], parts[1], parts[2], parts[3][:len(parts[3])-2] + "AA"}, ".")
	if _, err := open(other, tampered); err == nil {
		t.Fatal("a changed ciphertext opened")
	}
	for _, bad := range []string{"", "v2.a.b.c", "v1.a.b", "v1.!!.b.c", "Bearer plain-text-token"} {
		if _, err := open(other, bad); err == nil {
			t.Fatalf("%q opened", bad)
		}
	}
}

// The console's own sealing code, run under Node, makes an envelope this side opens — the two are
// written in different languages against the same description, and this is what holds them together.
func TestConsoleEnvelopeOpensHere(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	lib, err := filepath.Abs("../../../app/src/lib/seal.js")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(lib); err != nil {
		t.Skip("the console's source is not beside the CLI's")
	}
	key, _ := ecdh.P256().GenerateKey(rand.Reader)
	public := b64.EncodeToString(key.PublicKey().Bytes())
	// Written with escapes so the argument is plain ASCII on every platform; what is sealed, and what
	// must come back, is the value itself, non-ASCII characters and all.
	const secrets = `[{"board":"shop","server":"store","name":"Authorization","value":"Bearer \u00fcn\u00efcode-\u2713"}]`
	const sealedValue = `[{"board":"shop","server":"store","name":"Authorization","value":"Bearer ünïcode-✓"}]`
	// A file URL: three slashes before a Windows drive letter, two before a path that starts with one.
	libURL := "file://" + filepath.ToSlash(lib)
	if !strings.HasPrefix(filepath.ToSlash(lib), "/") {
		libURL = "file:///" + filepath.ToSlash(lib)
	}
	script := `import(process.argv[1]).then(async (m) => process.stdout.write(await m.sealSecrets(process.argv[2], JSON.parse(process.argv[3]))))`
	out, err := exec.Command(node, "-e", script, libURL, public, secrets).Output()
	if err != nil {
		t.Fatalf("sealing in node: %v", err)
	}
	plain, err := open(key, string(out))
	if err != nil {
		t.Fatalf("opening what the console sealed: %v", err)
	}
	if want := `{"v":1,"secrets":` + sealedValue + `}`; string(plain) != want {
		t.Fatalf("opened %s, want %s", plain, want)
	}
}
