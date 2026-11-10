from pathlib import Path
import json

root = Path(__file__).resolve().parents[1]
requirements = json.loads((root / "docs/requirements.json").read_text(encoding="utf-8"))
features = requirements["features"]
ids = [item["id"] for item in features]
assert ids == [f"F{i:03d}" for i in range(1, 167)], "Feature inventory is incomplete or duplicated"
excluded = {item["id"] for item in features if item["status"] == "排除"}
assert excluded == {"F024", "F054", "F055", "F161"}
assert next(item for item in features if item["id"] == "F114")["decision"] == "替换"
mapping = json.loads((root / "docs/linyu-mapping.json").read_text(encoding="utf-8"))
assert [item["id"] for item in mapping] == ids
assert requirements["target"]["connections"] == 10000
assert requirements["target"]["password_reveal"] is False
assert (root / "server/LICENSE").is_file()
assert requirements["target"]["cache"] == "Redis"
assert "保留" in requirements["target"]["frontend"]
assert all("linyu-client" not in item["upstream"] for item in mapping)
print("PASS: 166 unique requirements, 166 reuse mappings, four exclusions, and confirmed decisions.")
