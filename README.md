# waiter: plan progress for Claude Code

`waiter` is a Claude Code mod. While Claude works through a plan, it shows a progress bar
and the time left for each task.

- **It finds the plan by itself.** When Claude opens or edits a plan file, waiter picks it up.
  It reads many plan layouts:
  - `### Task 1:` / `## Phase 2` headings
  - numbered headings
  - checkbox lists
  - GSD `<task>` blocks

  With no plan file, it shows the session's own task list.
- **It knows what is finished** from:
  - the session's task list
  - git commits that name a task, like `Task 3` or `(4b Task 3)`
  - ticked checkboxes
- **The time estimates** come from how much text each task has in the plan. They improve as
  tasks finish, and what it learns carries over to later plans. Hands-on tasks (CONTROLLER,
  manual, acceptance) get a flat 20 minutes and are marked `[you]`.
- **It shows which step the current task is on**, like "step 3/5 ~8m". It finds the step from
  the files being changed right now (`git status` in every working folder of the repo,
  worktrees included), matched to the files or modules (`ops.burn` → `ops.py`) each step
  names. It reads only file names, never their contents.
- **It works across sessions.** Plan work done in another Claude session of the same project
  shows up within 2 minutes, through that session's git commits.
- **Minimize** turns it into one line above the prompt; **Expand** brings the full panel back.

## Install

You need Claude Code (terminal or the desktop app's Code tab). The mod was built on version
2.1.288, and the plugin system it uses is still early access. You also need `git`, to get the
mod and so waiter can see progress from commits.

1. **Clone the repo** into any folder outside `.claude`:

   Windows:

   ```
   git clone https://github.com/yarivzip/waiter D:\tools\waiter
   ```

   macOS / Linux:

   ```
   git clone https://github.com/yarivzip/waiter ~/tools/waiter
   ```

2. **Tell Claude Code to load it.** Open your personal settings file
   (`C:\Users\<you>\.claude\settings.json`, or `~/.claude/settings.json`) and add the line
   under `"env"`, pointing at the folder you cloned into.

   Windows (note the doubled backslashes):

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "D:\\tools\\waiter"
     }
   }
   ```

   macOS / Linux (write the full path, not `~`; on Linux it starts with `/home/<you>`):

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "/Users/<you>/tools/waiter"
     }
   }
   ```

   - If the file already has an `"env"` block, add only the `CLAUDE_CODE_PLUGIN_DIRS` line
     inside it, with a comma after the line above it.
   - If you already load other plugin folders this way, list them all in one value,
     separated by `;` on Windows or `:` on macOS / Linux.

3. **Start a new Claude Code session.** Sessions that are already running don't pick it up.

To check it loaded, type `/waiter`. It answers even before there is a plan.

**Update:** run `git pull` in that folder, then start a new session.

**Without git:** you can unzip a copy instead. Put it in a folder outside `.claude` so that
it directly contains `.claude-plugin`, `hooks` and `types`, then do steps 2 and 3. To update,
replace the folder with a newer zip.

## Use

Most of the time you do nothing: start executing a plan and the panel appears.

| Command | What it does |
| --- | --- |
| `/waiter` | open the panel |
| `/waiter path/to/plan.md` | track that plan file |
| `/waiter min` | minimize to one line above the prompt |
| `/waiter refresh` | re-read the plan and the commits now |
| `/waiter off` | stop tracking (it won't come back next session) |

The panel has the buttons **Minimize**, **Refresh** and **Stop tracking**. The one-line bar has
**Expand** and **Hide**. If you close the panel, it turns into the one-line bar.

## Good to know

- **Each session shows one plan.** It switches when the session opens a newer plan, starts
  writing one, or finishes the current one. An older plan opened only to look something up
  does not take over.
- **Waiter only reads files that Claude already opened** through its normal tools. Any guard
  hooks you have (for example, folders Claude must never open) still apply.
  `/waiter <path>` also goes through Claude's Read tool.
- **"saved, in review":** the newest task with a commit stays in this state for 20 minutes,
  because review and fix commits often follow. It also ends as soon as the next task starts.
- **Remove it:** delete the `CLAUDE_CODE_PLUGIN_DIRS` line and the folder.
- **Run its tests:** `claude plugin test <folder>`.
- **License:** MIT, see [LICENSE](LICENSE).
