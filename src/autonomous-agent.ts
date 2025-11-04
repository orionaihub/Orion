name = "autonomousagent"
main = "src/index.ts"
compatibility_date = "2025-11-04"

[[durable_objects.bindings]]
name = "AGENT"
class_name = "AutonomousAgent"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["AutonomousAgent"]
