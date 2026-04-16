package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

var (
	records  []map[string]string
	fields   []string
	filepath string
	loaded   bool
)

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Text()
		handleCommand(line)
	}
}

func respond(v interface{}) {
	b, _ := json.Marshal(v)
	fmt.Println(string(b))
}

func respondError(msg string) {
	respond(map[string]interface{}{"error": msg})
}

func respondOK(extra map[string]interface{}) {
	r := map[string]interface{}{"ok": true}
	for k, v := range extra {
		r[k] = v
	}
	respond(r)
}

func handleCommand(line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}

	if strings.HasPrefix(line, "expect ") {
		cmdExpect(line[7:])
	} else if strings.HasPrefix(line, "load ") {
		cmdLoad(strings.TrimSpace(line[5:]))
	} else if line == "save" {
		cmdSave()
	} else if line == "quit" {
		os.Exit(0)
	} else if strings.HasPrefix(line, "add ") {
		cmdAdd(line[4:])
	} else if line == "count" {
		cmdCount()
	} else if strings.HasPrefix(line, "select ") {
		cmdSelect(line[7:])
	} else if strings.HasPrefix(line, "delete ") {
		cmdDelete(line[7:])
	} else {
		respondError("unknown command")
	}
}

func cmdExpect(payload string) {
	if fields != nil {
		respondError("fields already set")
		return
	}

	var newFields []string
	if err := json.Unmarshal([]byte(payload), &newFields); err != nil {
		respondError(fmt.Sprintf("bad field list: %v", err))
		return
	}
	if len(newFields) == 0 {
		respondError("field list cannot be empty")
		return
	}

	fields = newFields
	respondOK(nil)
}

func cmdLoad(path string) {
	if fields == nil {
		respondError("must call expect first")
		return
	}

	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			filepath = path
			records = nil
			loaded = true
			respondOK(map[string]interface{}{"count": 0})
			return
		}
		respondError(fmt.Sprintf("cannot open file: %v", err))
		return
	}
	defer f.Close()

	var temp []map[string]string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	lineNum := 0
	for scanner.Scan() {
		lineNum++
		var rec map[string]string
		if err := json.Unmarshal(scanner.Bytes(), &rec); err != nil {
			respondError(fmt.Sprintf("bad record on line %d: %v", lineNum, err))
			return
		}
		if msg := validateRecord(rec); msg != "" {
			respondError(fmt.Sprintf("%s on line %d", msg, lineNum))
			return
		}
		temp = append(temp, rec)
	}

	if err := scanner.Err(); err != nil {
		respondError(fmt.Sprintf("read error: %v", err))
		return
	}

	filepath = path
	records = temp
	loaded = true
	respondOK(map[string]interface{}{"count": len(records)})
}

func cmdSave() {
	if !loaded {
		respondError("no file loaded")
		return
	}

	f, err := os.Create(filepath)
	if err != nil {
		respondError(fmt.Sprintf("cannot create file: %v", err))
		return
	}

	w := bufio.NewWriter(f)
	var writeErr error
	for _, rec := range records {
		b, err := json.Marshal(rec)
		if err != nil {
			writeErr = err
			break
		}
		if _, err := w.Write(b); err != nil {
			writeErr = err
			break
		}
		if err := w.WriteByte('\n'); err != nil {
			writeErr = err
			break
		}
	}
	if writeErr == nil {
		writeErr = w.Flush()
	}
	if err := f.Close(); err != nil && writeErr == nil {
		writeErr = err
	}

	if writeErr != nil {
		respondError(fmt.Sprintf("write error: %v", writeErr))
		return
	}

	respondOK(nil)
}

func cmdAdd(payload string) {
	if !loaded {
		respondError("no file loaded")
		return
	}

	var rec map[string]string
	if err := json.Unmarshal([]byte(payload), &rec); err != nil {
		respondError(fmt.Sprintf("bad json: %v", err))
		return
	}

	if msg := validateRecord(rec); msg != "" {
		respondError(msg)
		return
	}

	records = append(records, rec)
	respondOK(nil)
}

func validateRecord(rec map[string]string) string {
	for _, f := range fields {
		if _, ok := rec[f]; !ok {
			return fmt.Sprintf("missing field: %s", f)
		}
	}
	for k := range rec {
		found := false
		for _, f := range fields {
			if k == f {
				found = true
				break
			}
		}
		if !found {
			return fmt.Sprintf("unexpected field: %s", k)
		}
	}
	return ""
}

func matchRecord(rec map[string]string, filter map[string]string) bool {
	for k, v := range filter {
		rv, ok := rec[k]
		if !ok {
			return false
		}
		if !strings.Contains(strings.ToLower(rv), strings.ToLower(v)) {
			return false
		}
	}
	return true
}

func cmdCount() {
	if !loaded {
		respondError("no file loaded")
		return
	}
	respondOK(map[string]interface{}{"count": len(records)})
}

func cmdSelect(payload string) {
	if !loaded {
		respondError("no file loaded")
		return
	}

	var filter map[string]string
	if err := json.Unmarshal([]byte(payload), &filter); err != nil {
		respondError(fmt.Sprintf("bad json: %v", err))
		return
	}

	var results []map[string]string
	for _, rec := range records {
		if matchRecord(rec, filter) {
			results = append(results, rec)
		}
	}

	respondOK(map[string]interface{}{"count": len(results)})
	for _, rec := range results {
		b, _ := json.Marshal(rec)
		fmt.Println(string(b))
	}
}

func cmdDelete(payload string) {
	if !loaded {
		respondError("no file loaded")
		return
	}

	var filter map[string]string
	if err := json.Unmarshal([]byte(payload), &filter); err != nil {
		respondError(fmt.Sprintf("bad json: %v", err))
		return
	}

	count := 0
	kept := make([]map[string]string, 0, len(records))
	for _, rec := range records {
		if matchRecord(rec, filter) {
			count++
		} else {
			kept = append(kept, rec)
		}
	}
	records = kept

	respondOK(map[string]interface{}{"count": count})
}
