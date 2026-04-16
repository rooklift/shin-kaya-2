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

	records = nil
	filepath = path

	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			respondOK(map[string]interface{}{"count": 0})
			return
		}
		respondError(fmt.Sprintf("cannot open file: %v", err))
		return
	}
	defer f.Close()

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
		for _, field := range fields {
			if _, ok := rec[field]; !ok {
				respondError(fmt.Sprintf("missing field %q on line %d", field, lineNum))
				return
			}
		}
		records = append(records, rec)
	}

	if err := scanner.Err(); err != nil {
		respondError(fmt.Sprintf("read error: %v", err))
		return
	}

	respondOK(map[string]interface{}{"count": len(records)})
}

func cmdSave() {
	if filepath == "" {
		respondError("no file loaded")
		return
	}

	f, err := os.Create(filepath)
	if err != nil {
		respondError(fmt.Sprintf("cannot create file: %v", err))
		return
	}
	defer f.Close()

	w := bufio.NewWriter(f)
	for _, rec := range records {
		b, _ := json.Marshal(rec)
		w.Write(b)
		w.WriteByte('\n')
	}
	w.Flush()

	respondOK(nil)
}

func cmdAdd(payload string) {
	if fields == nil {
		respondError("no file loaded")
		return
	}

	var rec map[string]string
	if err := json.Unmarshal([]byte(payload), &rec); err != nil {
		respondError(fmt.Sprintf("bad json: %v", err))
		return
	}

	for _, f := range fields {
		if _, ok := rec[f]; !ok {
			respondError(fmt.Sprintf("missing field: %s", f))
			return
		}
	}

	records = append(records, rec)
	respondOK(nil)
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

func cmdSelect(payload string) {
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
