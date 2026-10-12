# Design brief

For the Hallmark design pass (milestone 2). Brad confirmed these answers on 2026-10-11. Run Hallmark's design flow with them as given; don't ask the three questions again.

- **Audience:** Brad alone, at the desk and on his phone.
- **Use case:** see what every session is doing at a glance; steer or stop one; start a session or save an idea in under ten seconds. Typing straight into a prompt box is always available.
- **Tone:** technical and atmospheric. Custom theme, not a catalog one, with Brad's defaults as hard constraints: dark, restrained cool neutrals, no browns, humanist sans-serif for UI (no serif, no grotesque), mono for code. Compact navigation, normal-sized headings, useful content and controls at the top. A tool: no logo, hero, tagline or filler. No decorative animation; motion only where it carries state.

The mobile feel is the priority. It should feel like a good native app on an iPhone: thumb-reachable controls, a composer that behaves well with the keyboard, safe areas, momentum, no layout jumps while text streams in.

## Ideas to work from

- **Home:** sessions grouped by project, with live state on each row (running, waiting on you, done, failed), the latest activity line, and elapsed time. A prompt box right there to start something.
- **Ideas:** drafts filed under their project, started with one tap. Brad especially likes this.
- **Summary first, transcript second:** one line per turn ("read 4 files · ran 2 commands · edited 3"), expandable to the tool calls.
- **Changes:** the session's diff since it started, files ordered by size, a compact `+84 −12` at the top.
- **Steer, stop, queue a follow-up** from the session screen.
- **Approvals** for `git push` and homelab hosts, one tap, reachable from a push notification.
- **Subscription meter:** the five-hour and weekly windows, thin, real numbers from the bridge.
- **Subagents** (later): children under the call that started them, each openable.
- **Failures as themselves:** a safeguard refusal, a bridge error and a test failure look different and say what happened.

## References

- Mario Zechner's Pi Durable phone app (x.com/badlogicgames/status/2109413968552820840): session list by machine and directory, a "Steer the current run" composer, a footer with model, thinking, cost and context, and subagents in a tree.
- Codex in the ChatGPT mobile app, Claude Code Remote Control, isogonalconjugate/pi-mobile, musingfox/cc-mobile, metaforismo/AgentKeys. Most are chat with tool cards and a composer; aludra should improve on that shape, not copy it.
