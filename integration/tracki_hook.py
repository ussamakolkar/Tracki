"""Tracki hook for a Python version of Parsable CV (Flask, Streamlit, Tk, CLI...).

Standard library only.

    from tracki_hook import ask_to_track

    ask_to_track(role="Senior Dev", company="Acme",
                 job_url="https://acme.com/jobs/42",
                 cv_file_path=r"D:\\CVs\\CV_Acme_v3.pdf")

With Tk available this pops a native yes/no dialog box and, on yes, writes the
job straight into the tracker. Without Tk it queues the prompt and the Tracki
window asks instead. Either way it never raises into your save path.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

DEFAULT_ORIGIN = os.environ.get("TRACKI_ORIGIN", "http://127.0.0.1:4321")

_FIELDS = (
    "role",
    "company",
    "job_url",
    "location",
    "cv_version",
    "cv_file_path",
    "notes",
    "status",
    "source",
)


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.title() for part in rest)


def _post(path: str, payload: dict, origin: str = DEFAULT_ORIGIN, timeout: float = 5.0) -> dict:
    request = urllib.request.Request(
        origin.rstrip("/") + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8")
    return json.loads(body) if body else {}


def _details(kwargs: dict) -> dict:
    return {_camel(key): value for key, value in kwargs.items() if key in _FIELDS and value not in (None, "")}


def queue_prompt(origin: str = DEFAULT_ORIGIN, **kwargs) -> dict:
    """Queue the 'add to tracker?' prompt for the Tracki window to raise."""
    return _post("/api/intake", _details(kwargs), origin)


def add_job(origin: str = DEFAULT_ORIGIN, **kwargs) -> dict:
    """Add the job with no prompt."""
    payload = _details(kwargs)
    payload["confirm"] = True
    return _post("/api/intake", payload, origin)


def _tk_confirm(role: str, company: str, cv_file_path: str) -> bool | None:
    try:
        import tkinter
        from tkinter import messagebox
    except Exception:
        return None
    try:
        root = tkinter.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        summary = " at ".join(part for part in (role, company) if part) or "this job"
        detail = f"CV saved: {cv_file_path}\n\n{summary}" if cv_file_path else summary
        answer = messagebox.askyesno("Tracki", f"Add this job to your tracker?\n\n{detail}")
        root.destroy()
        return bool(answer)
    except Exception:
        return None


def ask_to_track(origin: str = DEFAULT_ORIGIN, prefer_native: bool = True, **kwargs) -> dict:
    """Ask, then track. Returns a dict describing what happened.

    Never raises: a tracker that is not running must not break a CV save.
    """
    details = _details(kwargs)
    try:
        if prefer_native:
            answer = _tk_confirm(
                details.get("role", ""), details.get("company", ""), details.get("cvFilePath", "")
            )
            if answer is False:
                return {"added": False, "declined": True}
            if answer is True:
                payload = dict(details)
                payload["confirm"] = True
                result = _post("/api/intake", payload, origin)
                return {"added": True, "job": result.get("job")}
        result = _post("/api/intake", details, origin)
        return {"added": False, "queued": True, "pending_id": result.get("pendingId")}
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as err:
        return {"added": False, "error": f"Could not reach Tracki at {origin}: {err}"}


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Tell Tracki a CV was saved.")
    parser.add_argument("--role")
    parser.add_argument("--company")
    parser.add_argument("--job-url", dest="job_url")
    parser.add_argument("--location")
    parser.add_argument("--cv-file", dest="cv_file_path")
    parser.add_argument("--cv-version", dest="cv_version")
    parser.add_argument("--notes")
    parser.add_argument("--origin", default=DEFAULT_ORIGIN)
    parser.add_argument("--yes", action="store_true", help="skip the dialog and add it")
    args = vars(parser.parse_args())

    origin = args.pop("origin")
    confirm = args.pop("yes")
    fields = {key: value for key, value in args.items() if value}
    outcome = add_job(origin=origin, **fields) if confirm else ask_to_track(origin=origin, **fields)
    print(json.dumps(outcome, indent=2))
