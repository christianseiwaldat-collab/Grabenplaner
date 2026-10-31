"""Qualify the pinned response rule against the actual download route and unsafe mutations."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

from gates import check_sast_result


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--tools", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    from prepare_source_core import verify_bound_core
    scanner = verify_bound_core(root, args.output.resolve())['wrapperExecutable']
    source = (root / "server.js").read_bytes()
    text = source.decode("utf-8").replace("\r\n", "\n")
    start = 'app.post("/api/integrations/payroll-export/file", async (request, response) => {'
    end = 'app.get("/api/health/live",'
    assert text.count(start) == text.count(end) == 1
    route = text.split(start, 1)[1].split(end, 1)[0]
    route = start + route
    headers = '''  if (preflight.configuration.format === "xlsx") {
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  } else {
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
  }'''
    assert route.count(headers) == route.count("response.send(output);") == 1
    direct_input = route.replace("response.send(output);", "response.send(request.body);")
    unsafe = direct_input.replace(headers, "")
    cases = {
        "actual.js": route,
        "typed-direct-input.js": direct_input,
        "unsafe-a.js": unsafe,
        "unsafe-b.js": unsafe,
    }
    config = json.loads((root / "scripts/security/tools.json").read_text(encoding="utf-8"))
    manifest = json.loads((args.tools / "rules-manifest.json").read_text(encoding="utf-8"))
    assert manifest["commit"] == config["rules"]["commit"]
    assert manifest["archiveSha256"] == config["rules"]["sha256"]
    rule_name = "javascript/express/security/audit/xss/direct-response-write.yaml"
    rule = (args.tools / "rules" / rule_name).read_bytes()
    entry = next(row for row in manifest["files"] if row["path"] == rule_name)
    assert digest(rule) == entry["sha256"]
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gp-payroll-sast-") as directory:
        scratch = Path(directory)
        targets = scratch / "source"
        targets.mkdir()
        for name, content in cases.items():
            (targets / name).write_text(content, encoding="utf-8")
        rules = scratch / "response.yaml"
        rules.write_bytes(rule)
        result_path = scratch / "result.json"
        command = [scanner, "scan", "--config", str(rules), "--json", "--output", str(result_path),
                   "--metrics", "off", "--disable-version-check", "--disable-nosem", "--no-git-ignore", "--time",
                   "--max-target-bytes", "0", "--timeout", "30", "--timeout-threshold", "0",
                   "--jobs", "1", "--strict", "--error", str(targets)]
        completed = subprocess.run(command, capture_output=True, timeout=120, check=False)
        result = json.loads(result_path.read_text(encoding="utf-8"))
        assert result["version"] == config["semgrep"]["version"]
        assert completed.returncode == 1, "Unsafe controls must produce a findings exit"
        check_sast_result(result, set(cases), targets)
        findings = result["results"]
        assert {Path(row["path"]).name for row in findings} == {"unsafe-a.js", "unsafe-b.js"}
        assert all(row["check_id"].endswith("direct-response-write") for row in findings)
        receipt = {
            "passed": True, "serverSha256": digest(source), "routeSha256": digest(route.encode()),
            "ruleSha256": digest(rule), "scannerVersion": result["version"], "exitCode": completed.returncode,
            "cases": [{"name": name, "sha256": digest(content.encode()),
                       "findingCount": sum(Path(row["path"]).name == name for row in findings)}
                      for name, content in cases.items()],
            "scope": "Actual route plus mutations. Fixed non-HTML MIME branches suppress the XSS sink; removing both and sending direct request input is detected in both independent controls. No rule modification or finding exception.",
            "argv": command, "raw": result,
        }
        (args.output / "payroll-response-regression.json").write_text(
            json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"passed": True, "safeCases": 2, "detectedUnsafeControls": 2}))


if __name__ == "__main__":
    main()
