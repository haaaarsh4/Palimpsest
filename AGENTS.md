# Working rules for this repository

## Always stop the servers you start

**Standing instruction from the owner of this machine: every time you finish a
task, kill any server process you started. Do not leave one running.**

This is not a nicety, it happened and it confused them: they stopped
`npm run dev`, the site kept answering on `http://localhost:3000`, and there
was no obvious reason why. The reason was a server started here, detached
(`setsid`/`nohup`), which survives the shell that launched it and keeps
serving long after `npm run dev` is gone. A detached process is invisible to
the person using the machine.

So:

- start a dev server only while you actually need it, and note its PID;
- when the work is done, kill exactly that PID (and its children), then verify
  the port is free — `pgrep -af "node server.js"` and
  `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/` (expect
  `000`). Do not stop at "I ran kill": check.
- never use a broad `pkill -f node` — it can match the cleanup shell itself or
  a process that is not yours;
- if a server must stay up for the user (a long render, a background record
  walk), say so explicitly in the final message, with the PID and how to stop
  it, instead of leaving it silently.

Report in the final message that it was stopped and that the port is free.
