// Checks a PWX log folder with other people's code, to prove the formats are the public ones:
//   - golang.org/x/mod/sumdb/note verifies the log's checkpoint signature (signed-note, Ed25519)
//   - github.com/transparency-dev/formats verifies witnesses' cosignature/v1 lines
//   - golang.org/x/mod/sumdb/tlog checks every tile against the signed root and every entry's
//     inclusion proof (tlog-tiles uses the same tiles; only the path prefix differs)
//
// Usage: go run . <log dir> <log vkey> <quorum> <witness vkey>...
package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	fnote "github.com/transparency-dev/formats/note"
	"golang.org/x/mod/sumdb/note"
	"golang.org/x/mod/sumdb/tlog"
)

func fail(f string, a ...any) { fmt.Fprintf(os.Stderr, "FAIL "+f+"\n", a...); os.Exit(1) }

type dirTiles struct{ dir string }

func (d dirTiles) Height() int { return 8 }

// x/mod names tiles "tile/8/<L>/<N>"; tlog-tiles names them "tile/<L>/<N>".
func (d dirTiles) ReadTiles(ts []tlog.Tile) ([][]byte, error) {
	out := make([][]byte, len(ts))
	for i, t := range ts {
		p := strings.Replace(t.Path(), "tile/8/", "tile/", 1)
		b, err := os.ReadFile(filepath.Join(d.dir, p))
		if err != nil && t.W < 256 { // partial tile gone: use the full one's prefix
			full := t
			full.W = 256
			if b, err = os.ReadFile(filepath.Join(d.dir, strings.Replace(full.Path(), "tile/8/", "tile/", 1))); err == nil {
				b = b[:t.W*32]
			}
		}
		if err != nil {
			return nil, err
		}
		out[i] = b
	}
	return out, nil
}
func (d dirTiles) SaveTiles([]tlog.Tile, [][]byte) {}

func entries(dir string, size int64) [][]byte {
	var all [][]byte
	for b := int64(0); b*256 < size; b++ {
		w := size - b*256
		if w > 256 {
			w = 256
		}
		t := tlog.Tile{H: 8, L: 0, N: b, W: int(w)}
		p := strings.Replace(t.Path(), "tile/8/0/", "tile/entries/", 1)
		raw, err := os.ReadFile(filepath.Join(dir, p))
		if err != nil {
			fail("entries: %v", err)
		}
		for o := 0; o < len(raw); {
			n := int(raw[o])<<8 | int(raw[o+1])
			all = append(all, raw[o+2:o+2+n])
			o += 2 + n
		}
	}
	return all
}

func main() {
	if len(os.Args) < 4 {
		fail("usage: <dir> <log vkey> <quorum> <witness vkey>...")
	}
	dir, logVkey := os.Args[1], os.Args[2]
	quorum, _ := strconv.Atoi(os.Args[3])
	lv, err := note.NewVerifier(logVkey)
	if err != nil {
		fail("log vkey: %v", err)
	}
	verifiers := []note.Verifier{lv}
	for _, wk := range os.Args[4:] {
		v, err := fnote.NewVerifierForCosignatureV1(wk)
		if err != nil {
			fail("witness vkey: %v", err)
		}
		verifiers = append(verifiers, v)
	}
	text, err := os.ReadFile(filepath.Join(dir, "checkpoint"))
	if err != nil {
		fail("%v", err)
	}
	n, err := note.Open(text, note.VerifierList(verifiers...))
	if err != nil {
		fail("note: %v", err)
	}
	logOK, witnesses := false, 0
	for _, s := range n.Sigs {
		if s.Name == lv.Name() && s.Hash == lv.KeyHash() {
			logOK = true
		} else {
			witnesses++
			if ts, err := fnote.CoSigV1Timestamp(s); err == nil {
				fmt.Printf("witness %s co-signed at %s\n", s.Name, ts.UTC().Format("2006-01-02 15:04:05"))
			}
		}
	}
	if !logOK || witnesses < quorum {
		fail("signatures: log=%v witnesses=%d of %d", logOK, witnesses, quorum)
	}
	lines := strings.Split(n.Text, "\n")
	size, _ := strconv.ParseInt(lines[1], 10, 64)
	rootB, _ := base64.StdEncoding.DecodeString(lines[2])
	var root tlog.Hash
	copy(root[:], rootB)
	tree := tlog.Tree{N: size, Hash: root}
	hr := tlog.TileHashReader(tree, dirTiles{dir})
	all := entries(dir, size)
	if int64(len(all)) != size {
		fail("entries: %d, checkpoint says %d", len(all), size)
	}
	for i, e := range all {
		p, err := tlog.ProveRecord(size, int64(i), hr)
		if err != nil {
			fail("prove %d: %v", i, err)
		}
		if err := tlog.CheckRecord(p, size, root, int64(i), tlog.RecordHash(e)); err != nil {
			fail("entry %d: %v", i, err)
		}
	}
	fmt.Printf("OK %s: size %d, log signature and %d witness co-signatures verified, %d entries proven from tiles\n", lines[0], size, witnesses, size)
}
