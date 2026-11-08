/** The exit code of {@link pollScript} when the runtime is gone. */
export const runtimeGoneExitCode = 3

/**
 * Waits inside the sandbox until the outbox has more lines than the engine has read, then prints
 * the new ones. Plain POSIX shell, so nothing has to be copied into the sandbox for it.
 *
 * Arguments: the outbox, the runtime's pid file, the number of lines already read, how many
 * quarter seconds to wait at most, and a directory where it keeps its own pid while it runs, so
 * {@link stopPollsScript} can find it. Exits 0 with the new lines (or none, when the wait ran out),
 * and {@link runtimeGoneExitCode} when the runtime is gone and has nothing more to say. A zombie counts as gone. The state is
 * read after the last `)` of `/proc/<pid>/stat`, because a process name can hold spaces; no pid yet
 * counts as alive.
 */
export const pollScript = `
outbox=$1 pidFile=$2 after=$3 tries=$4 polls=$5
mkdir -p "$polls" && echo $$ > "$polls/$$"
trap 'rm -f "$polls/$$"' EXIT
lines() { if [ -f "$outbox" ]; then wc -l < "$outbox"; else echo 0; fi; }
alive() {
	pid=$(cat "$pidFile" 2>/dev/null)
	[ -n "$pid" ] || return 0
	stat=$(cat "/proc/$pid/stat" 2>/dev/null) || return 1
	state=\${stat##*") "}
	state=\${state%% *}
	[ "$state" != Z ] && [ "$state" != X ]
}
i=0
while [ "$(lines)" -le "$after" ]; do
	if ! alive; then
		[ "$(lines)" -le "$after" ] && exit ${String(runtimeGoneExitCode)}
		break
	fi
	[ "$i" -ge "$tries" ] && exit 0
	sleep 0.25
	i=$((i + 1))
done
tail -n "+$((after + 1))" "$outbox"
`

/**
 * Ends every {@link pollScript} still running in the sandbox. Aborting a poll ends the call on the
 * host, not always the loop inside the sandbox, and gVisor can't restore a checkpoint that holds a
 * process an exec started. It then waits out a last `sleep 0.25` of a loop it ended.
 */
export const stopPollsScript = `
for file in "$1"/*; do
	[ -f "$file" ] || continue
	kill "$(cat "$file")" 2>/dev/null
	rm -f "$file"
done
sleep 0.5
`
