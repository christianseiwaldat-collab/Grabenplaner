"""Local GP CP-SAT service. JSON-lines over inherited pipes; no network or DB access."""
import json
import sys
import time
import ortools
from ortools.sat.python import cp_model

MAX_BYTES = 2_000_000


def integer(value, lower, upper):
    if type(value) is not int or not lower <= value <= upper:
        raise ValueError("invalid integer")
    return value


def solve(problem):
    if problem.get("schemaVersion") != 2:
        raise ValueError("unsupported schema")
    candidates = problem["candidates"]
    employees = problem["employees"]
    groups = problem["groups"]
    if not 0 <= len(candidates) <= 3000 or not 1 <= len(employees) <= 100 or len(groups) > 12000:
        raise ValueError("scope limit")
    count = len(candidates)
    ids = {p["id"] for p in employees}
    if len(ids) != len(employees):
        raise ValueError("duplicate employee")
    for c in candidates:
        if c["employeeId"] not in ids:
            raise ValueError("unknown employee")
        integer(c["minutes"], 1, 1440)
        integer(c["preferenceCost"], 0, 10000)
        integer(c["saturday"], 0, 1)
    model = cp_model.CpModel()
    chosen = [model.new_bool_var(f"s{i}") for i in range(count)]
    assumptions = {}
    for index, group in enumerate(groups):
        members = [chosen[integer(i, 0, count - 1)] for i in group["indices"]]
        minimum = integer(group.get("minimum", 0), 0, 100)
        maximum = integer(group.get("maximum", len(members)), 0, 3000)
        gate = model.new_bool_var(f"rule{index}")
        model.add(sum(members) >= minimum).only_enforce_if(gate)
        model.add(sum(members) <= maximum).only_enforce_if(gate)
        model.add_assumption(gate)
        assumptions[gate.index] = index
    for cut in problem.get("forbidden", []):
        selected = set(integer(i, 0, count - 1) for i in cut)
        model.add(sum(chosen[i] if i in selected else 1 - chosen[i] for i in range(count)) <= count - 1)
    hours_deviation = []
    weekend_totals = []
    for employee in employees:
        target = integer(employee["targetMinutes"], 0, 10080)
        credit = integer(employee.get("creditMinutes", 0), 0, 10080)
        terms = [(i, c) for i, c in enumerate(candidates) if c["employeeId"] == employee["id"]]
        actual = sum(chosen[i] * c["minutes"] for i, c in terms) + credit
        delta = model.new_int_var(0, 100800, f'delta{employee["id"]}')
        model.add_abs_equality(delta, actual - target)
        hours_deviation.append(delta)
        weekend = model.new_int_var(0, 1000, f'weekend{employee["id"]}')
        saturday = model.new_bool_var(f'saturday{employee["id"]}')
        model.add_max_equality(saturday, [chosen[i] for i, c in terms if c["saturday"]] + [0])
        model.add(weekend == integer(employee.get("saturdayHistory", 0), 0, 900) + saturday)
        weekend_totals.append(weekend)
    weekend_max = model.new_int_var(0, 1000, "weekendMax")
    weekend_min = model.new_int_var(0, 1000, "weekendMin")
    model.add_max_equality(weekend_max, weekend_totals)
    model.add_min_equality(weekend_min, weekend_totals)
    baseline = [integer(i, 0, count - 1) for i in problem.get("baselineIndices", [])]
    added = sum(chosen[i] for i in range(count) if i not in set(baseline))
    removed = sum(1 - chosen[i] for i in baseline)
    preferences = sum(chosen[i] * c["preferenceCost"] for i, c in enumerate(candidates))
    profiles = {"stable": (600, 1, 25, 20), "balanced": (180, 3, 60, 100), "wishes": (120, 2, 300, 60)}
    scenario = problem.get("profile", "balanced")
    change_w, hours_w, preference_w, fair_w = profiles[scenario]
    model.minimize((added + removed) * change_w + sum(hours_deviation) * hours_w + preferences * preference_w + (weekend_max - weekend_min) * fair_w)
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = integer(problem.get("timeLimitSeconds", 3), 1, 10)
    solver.parameters.max_memory_in_mb = 256
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 0
    started = time.monotonic()
    status = solver.solve(model)
    result = {"schemaVersion": 2, "engine": "OR-Tools CP-SAT", "engineVersion": ortools.__version__,
              "status": solver.status_name(status), "durationMs": round((time.monotonic() - started) * 1000), "selected": []}
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        result.update(selected=[i for i in range(count) if solver.value(chosen[i])], objective=solver.objective_value,
                      bound=solver.best_objective_bound,
                      metrics={"changedShifts": int(solver.value(added + removed)), "targetDeviationMinutes": int(sum(solver.value(x) for x in hours_deviation)),
                               "preferencePenalty": int(solver.value(preferences)), "saturdaySpread": solver.value(weekend_max) - solver.value(weekend_min)})
    elif status == cp_model.INFEASIBLE:
        result["conflictingGroups"] = [assumptions[i] for i in solver.sufficient_assumptions_for_infeasibility() if i in assumptions]
    return result


if __name__ == "__main__":
    for line in sys.stdin.buffer:
        try:
            if len(line) > MAX_BYTES:
                raise ValueError("input limit")
            request = json.loads(line)
            result = {"engine": "OR-Tools CP-SAT", "version": ortools.__version__, "schemaVersion": 2} if request.get("action") == "health" else solve(request)
            print(json.dumps(result, separators=(",", ":")), flush=True)
        except Exception:
            # Never log personnel facts or received input, including on failure.
            print(json.dumps({"error": "OPTIMIZER_INPUT_OR_RUNTIME_ERROR"}), flush=True)
