# Sourced by every fake. Appends this invocation's argv, as one JSON array per
# line, to $FAKE_DIR/calls/<name>.log — exact argv, so tests can assert on
# argument lists (and scan them for secrets) without word-splitting ambiguity.
_fake_log() {
  local name="$1"; shift
  mkdir -p "$FAKE_DIR/calls"
  jq -cn '$ARGS.positional' --args -- "$@" >>"$FAKE_DIR/calls/$name.log"
}
