#!/usr/bin/env bash
# Optional: terminate TLS on a domain of your own, via Let's Encrypt's
# Cloudflare DNS-01 challenge. Entirely optional — nothing here runs unless a
# domain is configured, by prompt or by environment variable.
#
# This step OWNS the prompts, the Cloudflare API calls, certbot, the
# credentials file and the deploy hook, and is the ONLY writer of the
# HTTPS_DOMAIN / HTTPS_EMAIL sticky settings — scripts/66-install-nginx.sh only
# ever reads them. Applying a change means re-invoking 66 as a child once this
# step is done, so `--only https` alone is enough; the operator never has to
# also remember `--only nginx`.
#
# NEVER fails the install: every exit below is 0. A bad domain, a rejected
# token, a Cloudflare API error, or a certbot failure all just warn, print the
# exact retry command, and leave whatever already worked (nginx on the
# tailnet, an existing certificate) untouched.
#
#   HTTPS_DOMAIN=none sudo install.sh --only https        # disable
#   HTTPS_DOMAIN=new.example.com sudo install.sh --only https   # change
#   HTTPS_DOMAIN= sudo install.sh --only https             # ask again
#   HTTPS_DOMAIN=x HTTPS_EMAIL=y CLOUDFLARE_API_TOKEN=z sudo install.sh --yes  # unattended

_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$_dir/lib/common.sh"
# shellcheck source=scripts/lib/config.sh
. "$_dir/lib/config.sh"

log_step "https"
require_root

# What was actually saved by an earlier run, independent of anything the
# operator passed this run — the only way to tell "disabling a domain that was
# really configured" apart from "asked for 'none' when nothing was ever set",
# and "the saved domain is unchanged" apart from "this is a new one".
previous_domain="$(setting_recall HTTPS_DOMAIN || true)"

sticky_recall HTTPS_DOMAIN
sticky_recall HTTPS_EMAIL

# Out of the environment immediately — never let it sit around where a `ps`
# of this process, or an accidental `env` dump, could show it. Every
# subsequent use goes through the local `tok`.
tok="${CLOUDFLARE_API_TOKEN:-}"
unset CLOUDFLARE_API_TOKEN

RETRY_HINT="sudo $INSTALL_SH --only https"

# --- dry run: describe, touch nothing -----------------------------------------
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  if [[ "$HTTPS_DOMAIN" == "none" ]]; then
    log_info "[dry-run] HTTPS_DOMAIN=none — would leave custom-domain HTTPS disabled."
  elif [[ -z "$HTTPS_DOMAIN" ]]; then
    log_info "[dry-run] No HTTPS_DOMAIN configured; would prompt if a terminal is available, else skip."
  else
    log_info "[dry-run] Would validate HTTPS_DOMAIN=$HTTPS_DOMAIN, look up its Cloudflare zone,"
    log_info "[dry-run]   ensure its DNS A record points at this node's Tailscale IPv4,"
    if https_cert_present "$HTTPS_DOMAIN"; then
      log_info "[dry-run]   and skip certbot — a certificate already exists."
    else
      log_info "[dry-run]   and run certbot to obtain a certificate via DNS-01."
    fi
    log_info "[dry-run] Would then re-run the nginx step and probe https://$HTTPS_DOMAIN/."
  fi
  exit 0
fi

# ------------------------------------------------------------------------------
# Cloudflare API — every call goes through here, so the token only ever
# appears in one place, passed as a header file (curl's `-H @<(...)`) rather
# than a command-line argument, which keeps it out of `ps` and out of any
# argv-echoing log line.
#
# The `-H @<(...)` MUST be written on the same simple command as `curl`
# itself, not built up into an `args=(...)` array in an earlier statement:
# bash (5.2+) closes a process substitution's file descriptor once the
# command that created it finishes — and `local -a args=(... <(...) ...)` is
# itself a complete command, so by the time `curl "${args[@]}"` ran on the
# next line, /dev/fd/N was already closed and curl failed with "option -H:
# error encountered when reading a file", sending the request with no
# Authorization header at all. Keeping the process substitution on curl's own
# command line keeps its fd open for exactly as long as curl needs it.
cf_api() {
  local method="$1" path="$2" json="${3:-}"
  local -a args=(-sS --max-time 20 -X "$method")
  [[ -n "$json" ]] && args+=(--data "$json")
  curl "${args[@]}" \
    -H @<(printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$tok") \
    "https://api.cloudflare.com/client/v4${path}"
}

cf_credentials_exist() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    [[ -s "$HTTPS_CF_CREDENTIALS" ]]
  else
    have sudo && sudo -n test -s "$HTTPS_CF_CREDENTIALS" 2>/dev/null
  fi
}

read_stored_token() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    sed -n 's/^dns_cloudflare_api_token[[:space:]]*=[[:space:]]*//p' "$HTTPS_CF_CREDENTIALS" 2>/dev/null | tail -1
  else
    sudo -n sed -n 's/^dns_cloudflare_api_token[[:space:]]*=[[:space:]]*//p' "$HTTPS_CF_CREDENTIALS" 2>/dev/null | tail -1
  fi
}

# Not via as_root/run: the token would never actually appear in their logged
# argv either (it travels over stdin, via the printf builtin), but calling
# sudo/install directly here keeps that guarantee obvious rather than relying
# on run()'s DRY_RUN branch never being reached (it can't be — this step
# returns long before here whenever DRY_RUN=1 — but the point is not to have
# to reason about that to trust the token never leaks).
write_cf_credentials() {
  local t="$1"
  # Removed first, not just overwritten: some install(1) implementations
  # (uutils' coreutils reimplementation, in particular) fail to replace an
  # existing file when the source is a pipe rather than a seekable regular
  # file. Cheap and harmless everywhere else, since install recreates it with
  # the right mode regardless.
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    rm -f "$HTTPS_CF_CREDENTIALS" 2>/dev/null || true
    printf 'dns_cloudflare_api_token = %s\n' "$t" | install -m 0600 /dev/stdin "$HTTPS_CF_CREDENTIALS"
  else
    sudo rm -f "$HTTPS_CF_CREDENTIALS" 2>/dev/null || true
    printf 'dns_cloudflare_api_token = %s\n' "$t" | sudo install -m 0600 /dev/stdin "$HTTPS_CF_CREDENTIALS"
  fi
}

write_deploy_hook() {
  as_root install -d -m 0755 "$(dirname "$HTTPS_DEPLOY_HOOK")"
  local tmp; tmp="$(mktemp)"
  cat >"$tmp" <<'HOOK'
#!/bin/sh
nginx -t -q && systemctl reload nginx
HOOK
  as_root install -m 0755 "$tmp" "$HTTPS_DEPLOY_HOOK"
  rm -f "$tmp"
  log_ok "Deploy hook ready: $HTTPS_DEPLOY_HOOK"
}

# True for the CGNAT range Tailscale hands out addresses from (100.64.0.0/10).
is_cgnat_ip() {
  local ip="$1"
  [[ "$ip" =~ ^100\.([0-9]{1,3})\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  local o2="${BASH_REMATCH[1]}"
  (( o2 >= 64 && o2 <= 127 ))
}

# True for the private ranges a "pointed it at the local IP" setup would use
# (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) — never a real public address,
# so a record already parked there cannot be serving anyone's public site.
is_private_ip() {
  local ip="$1"
  [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  local o1="${BASH_REMATCH[1]}" o2="${BASH_REMATCH[2]}"
  (( o1 == 10 )) && return 0
  (( o1 == 172 && o2 >= 16 && o2 <= 31 )) && return 0
  (( o1 == 192 && o2 == 168 )) && return 0
  return 1
}

# Walks up the labels (ai.example.com, then example.com, ...) until Cloudflare
# reports a zone — the first hit both identifies the zone and proves the token
# actually covers it. Deliberately not /user/tokens/verify, which rejects
# account-owned (as opposed to user-owned) tokens even when they work fine.
# Prints "ZONE_ID ZONE_NAME" on success.
find_zone() {
  local d="$1" candidate="$1" resp zone_id
  while [[ "$candidate" == *.* ]]; do
    resp="$(cf_api GET "/zones?name=${candidate}")" || return 1
    if [[ "$(jq -r '.success // false' <<<"$resp" 2>/dev/null)" == "true" ]]; then
      zone_id="$(jq -r '.result[0].id // empty' <<<"$resp" 2>/dev/null)"
      if [[ -n "$zone_id" ]]; then
        printf '%s %s\n' "$zone_id" "$candidate"
        return 0
      fi
    fi
    candidate="${candidate#*.}"
  done
  return 1
}

# Creates or fixes the A record so it points at this node's Tailscale IPv4,
# DNS-only (never proxied — Cloudflare's proxy would terminate TLS itself and
# never reach this host at all). Never destructive: a single existing A
# record is only touched when it already looks like ours —
#   - content in the Tailscale CGNAT range (100.64.0.0/10), or
#   - content in a private range (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
#     — what "pointed it at the local IP" looks like, and cannot be serving
#     a public site either way), or
#   - carrying our own "${APP_NAME} installer" comment.
# `proxied` on its own is deliberately NOT one of these signals: a proxied
# record sitting on a real public IP is exactly what an operator's existing,
# unrelated Cloudflare-proxied website looks like, and PATCHing it to our IP
# with proxied:false would just have taken that site down. Anything else (a
# public IP with none of the above) is left alone with a warning instead —
# the certificate is still issued regardless, since DNS-01 never needs this
# record at all.
manage_dns_record() {
  local d="$1" zone_id="$2" our_ip="$3" resp

  if [[ -z "$our_ip" ]]; then
    log_warn "This node's Tailscale IPv4 is unavailable; leaving Cloudflare DNS alone."
    log_warn "The certificate does not need it (DNS-01 challenges do not use the A record)."
    return 0
  fi

  resp="$(cf_api GET "/zones/${zone_id}/dns_records?name=${d}")" || {
    log_warn "Could not list Cloudflare DNS records for $d."
    return 0
  }
  if [[ "$(jq -r '.success // false' <<<"$resp" 2>/dev/null)" != "true" ]]; then
    log_warn "Cloudflare rejected the DNS record lookup for $d."
    return 0
  fi

  local aaaa_count cname_count a_count
  aaaa_count="$(jq -r '[.result[]? | select(.type=="AAAA")] | length' <<<"$resp")"
  cname_count="$(jq -r '[.result[]? | select(.type=="CNAME")] | length' <<<"$resp")"
  a_count="$(jq -r '[.result[]? | select(.type=="A")] | length' <<<"$resp")"

  if (( aaaa_count > 0 || cname_count > 0 )); then
    log_warn "$d already has an AAAA or CNAME record; leaving Cloudflare DNS alone."
    return 0
  fi

  if (( a_count == 0 )); then
    local body
    body="$(jq -n --arg name "$d" --arg content "$our_ip" --arg comment "${APP_NAME} installer" \
      '{type:"A",name:$name,content:$content,ttl:1,proxied:false,comment:$comment}')"
    resp="$(cf_api POST "/zones/${zone_id}/dns_records" "$body")" || {
      log_warn "Could not create the Cloudflare A record for $d."
      return 0
    }
    if [[ "$(jq -r '.success // false' <<<"$resp" 2>/dev/null)" == "true" ]]; then
      log_ok "Created Cloudflare A record: $d -> $our_ip (DNS-only)"
    else
      log_warn "Cloudflare rejected creating the A record for $d."
    fi
    return 0
  fi

  if (( a_count > 1 )); then
    log_warn "$d has more than one A record; leaving Cloudflare DNS alone."
    return 0
  fi

  local rec_id rec_ip rec_proxied rec_comment
  rec_id="$(jq -r '[.result[]? | select(.type=="A")][0].id' <<<"$resp")"
  rec_ip="$(jq -r '[.result[]? | select(.type=="A")][0].content' <<<"$resp")"
  rec_proxied="$(jq -r '[.result[]? | select(.type=="A")][0].proxied' <<<"$resp")"
  rec_comment="$(jq -r '[.result[]? | select(.type=="A")][0].comment // empty' <<<"$resp")"

  if [[ "$rec_ip" == "$our_ip" && "$rec_proxied" == "false" ]]; then
    log_ok "Cloudflare A record for $d already points at $our_ip (DNS-only)."
    return 0
  fi

  if is_cgnat_ip "$rec_ip" || is_private_ip "$rec_ip" || [[ "$rec_comment" == "${APP_NAME} installer" ]]; then
    local body
    body="$(jq -n --arg content "$our_ip" '{content:$content, proxied:false}')"
    resp="$(cf_api PATCH "/zones/${zone_id}/dns_records/${rec_id}" "$body")" || {
      log_warn "Could not update the Cloudflare A record for $d."
      return 0
    }
    if [[ "$(jq -r '.success // false' <<<"$resp" 2>/dev/null)" == "true" ]]; then
      log_ok "Updated Cloudflare A record: $d -> $our_ip (DNS-only)"
    else
      log_warn "Cloudflare rejected updating the A record for $d."
    fi
  else
    log_warn "$d's A record points at $rec_ip, which does not look like ours; leaving Cloudflare DNS alone."
    log_warn "Point it at $our_ip yourself (DNS-only, not proxied) if you want this to be reachable."
  fi
}

check_dns_resolution() {
  local d="$1" our_ip="$2" resolved
  resolved="$(dig +short @1.1.1.1 "$d" A 2>/dev/null | tail -1)"
  [[ -n "$resolved" ]] || resolved="$(getent hosts "$d" 2>/dev/null | awk '{print $1}' | head -1)"
  if [[ -z "$resolved" ]]; then
    log_warn "$d does not resolve yet — DNS may still be propagating."
  elif [[ -n "$our_ip" && "$resolved" != "$our_ip" ]]; then
    log_warn "$d resolves to $resolved, not this node's Tailscale IP ($our_ip)."
    log_warn "DNS may still be propagating, or it points elsewhere on purpose."
  else
    log_ok "$d resolves to $resolved"
  fi
}

# Whether PROMPT_TTY can actually be opened right now — used only below, to
# tell "no terminal exists at all" (cron, CI, no controlling tty) apart from
# "a terminal exists but sudo isn't forwarding it". _prompt_reachable() in
# lib/common.sh can't answer that by itself: once SUDO_USER is set and stdin
# isn't a terminal, it returns false WITHOUT ever trying to open PROMPT_TTY,
# precisely to never risk a read() blocking on a keystroke that can never
# arrive — so by the time can_prompt() says no, whether a terminal exists at
# all has often never actually been tested.
#
# Existence is checked first because `<>` (read-write) CREATES a plain file
# that doesn't exist yet, which would turn "nothing there" into "openable"
# the moment we tried; skipping the open entirely for a path that doesn't
# exist avoids that. Real terminal devices (/dev/tty) always exist as a node
# regardless of whether this process has a controlling terminal, so this
# never masks the case that matters. Opened read-write rather than read-only
# so a FIFO nobody has written to yet doesn't block the open (a read-only
# open would) — and closed at once, with no `read`, so nothing meant for
# ask()/confirm() is ever consumed.
https_prompt_tty_openable() {
  [[ -e "$PROMPT_TTY" ]] || return 1
  local fd
  { exec {fd}<>"$PROMPT_TTY"; } 2>/dev/null || return 1
  exec {fd}<&-
}

# The three ways to actually finish this later — common to every reason below
# for why the domain prompt itself was skipped, so kept in one place rather
# than retyped (and risking drift) in each.
https_howto_finish_later() {
  local log="$1"
  "$log" "To set it up now, from a terminal:"
  "$log" "    sudo $INSTALL_SH --only https,summary"
  "$log" "Or unattended, right now:"
  "$log" "    HTTPS_DOMAIN=your.domain HTTPS_EMAIL=you@example.com CLOUDFLARE_API_TOKEN=... $RETRY_HINT --yes"
  "$log" "Or skip it for good:"
  "$log" "    HTTPS_DOMAIN=none $RETRY_HINT"
}

# --- branch: explicitly disabled ----------------------------------------------
if [[ "$HTTPS_DOMAIN" == "none" ]]; then
  setting_remember HTTPS_DOMAIN "none"
  if [[ -n "$previous_domain" && "$previous_domain" != "none" ]]; then
    log_info "Disabling custom-domain HTTPS (was $previous_domain)."
    log_info "The certificate and Cloudflare DNS record for $previous_domain are left in place."
    log_info "Delete the certificate yourself if you no longer want it:"
    log_info "    sudo certbot delete --cert-name $previous_domain"
    if bash "$SCRIPTS_DIR/66-install-nginx.sh"; then
      log_ok "nginx re-configured — https://$previous_domain/ is no longer served; the tailnet is unaffected."
    else
      log_warn "Re-running the nginx step failed; run it yourself:  sudo $INSTALL_SH --only nginx"
    fi
  else
    log_info "Custom-domain HTTPS stays disabled. To enable it later:"
    log_info "    HTTPS_DOMAIN=your.domain HTTPS_EMAIL=you@example.com CLOUDFLARE_API_TOKEN=... $RETRY_HINT"
  fi
  exit 0
fi

# --- branch: never answered ---------------------------------------------------
if [[ -z "$HTTPS_DOMAIN" ]]; then
  if ! can_prompt; then
    # can_prompt() says no for one of four reasons, and the operator gets a
    # distinct explanation for each rather than one catch-all "skipped":
    #   - ASSUME_YES=1: they said not to ask.
    #   - DRY_RUN=1: never reaches here — the dry-run branch at the very top
    #     of this script exits first, whatever HTTPS_DOMAIN is.
    #   - PROMPT_TTY cannot be opened at all (cron, CI, no /dev/tty): there
    #     is no keyboard to reach here, sudo or not.
    #   - PROMPT_TTY opens but stdin isn't a terminal under sudo: `curl ... |
    #     sudo bash` hands sudo's own stdin a pipe, so it never forwards the
    #     operator's keystrokes into the pty it runs this in (see
    #     _prompt_reachable in lib/common.sh) — the operator IS at a
    #     keyboard, they are just not being heard.
    # Openability is checked (https_prompt_tty_openable) before the sudo/stdin
    # case below, so a SUDO_USER set on a box with no /dev/tty at all is never
    # told it was "piped into sudo" — there is no terminal to have been piped
    # past in the first place.
    if [[ "${ASSUME_YES:-0}" == "1" ]]; then
      log_info "Custom-domain HTTPS was not configured: --yes was given, so the prompt was skipped."
      https_howto_finish_later log_info
      log_info "Or run interactively (needs a terminal, and not --yes):  $RETRY_HINT"
    elif [[ -n "${SUDO_USER:-}" && ! -t 0 ]] && https_prompt_tty_openable; then
      log_warn "HTTPS on your own domain was not set up: this run can't read keyboard input"
      log_warn "(the script was piped into sudo, which never forwards your terminal to it)."
      https_howto_finish_later log_warn
    else
      log_info "Custom-domain HTTPS was not configured: no terminal is available to ask on."
      https_howto_finish_later log_info
    fi
    exit 0
  fi

  log_info "Custom-domain HTTPS is optional — press Enter to skip."
  log_info "The domain must be in a Cloudflare zone you control. The installer will create"
  log_info "or fix its DNS A record to point at this node's Tailscale IP, so it stays"
  log_info "reachable only over the tailnet."
  domain="" attempts=0
  while (( attempts < 3 )); do
    ask answer "Domain to serve over HTTPS (empty to skip)"
    if [[ -z "$answer" ]]; then
      domain=""
      break
    fi
    answer="${answer,,}"; answer="${answer%.}"
    if https_domain_valid "$answer"; then
      domain="$answer"
      break
    fi
    log_warn "'$answer' doesn't look like a valid domain (lowercase FQDN, e.g. ai.example.com)."
    attempts=$(( attempts + 1 ))
  done

  if (( attempts >= 3 )); then
    log_warn "Could not get a valid domain after 3 attempts. Nothing was changed."
    log_warn "Retry with:  $RETRY_HINT"
    exit 0
  fi

  if [[ -z "$domain" ]]; then
    setting_remember HTTPS_DOMAIN "none"
    log_info "Custom-domain HTTPS disabled. Enable it later with:"
    log_info "    HTTPS_DOMAIN=your.domain HTTPS_EMAIL=you@example.com CLOUDFLARE_API_TOKEN=... $RETRY_HINT"
    exit 0
  fi
  HTTPS_DOMAIN="$domain"

  email="" attempts=0
  while (( attempts < 3 )); do
    ask answer "Email for Let's Encrypt expiry notices" "$HTTPS_EMAIL"
    if [[ "$answer" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
      email="$answer"
      break
    fi
    log_warn "'$answer' doesn't look like a valid email address."
    attempts=$(( attempts + 1 ))
  done
  if [[ -z "$email" ]]; then
    log_warn "Could not get a valid email after 3 attempts. Nothing was changed."
    log_warn "Retry with:  $RETRY_HINT"
    exit 0
  fi
  HTTPS_EMAIL="$email"

  have_stored=0
  cf_credentials_exist && have_stored=1

  # Best-guess zone for step 4 below: the last two labels of the domain
  # (ai.example.com -> example.com). The same "strip labels from the left"
  # idiom find_zone() uses to actually resolve it a few lines down — this is
  # only ever a guess to save a click, never trusted for anything real.
  zone_guess="$domain"
  while [[ "$zone_guess" == *.*.* ]]; do
    zone_guess="${zone_guess#*.}"
  done

  log_info "Create a Cloudflare API token (about a minute):"
  log_info "  1. Open https://dash.cloudflare.com/profile/api-tokens"
  log_info "  2. Create Token -> \"Edit zone DNS\" template -> Use template"
  log_info "  3. Permissions: leave \"Zone / DNS / Edit\" as it is"
  log_info "  4. Zone Resources: \"Include / Specific zone / $zone_guess\"  (the zone that contains $domain)"
  log_info "  5. Continue to summary -> Create Token -> copy the token (Cloudflare shows it only once)"
  log_info "Not the \"Global API Key\"."
  log_info "Paste it below and press Enter — input is hidden, so nothing appears while you paste."

  token_label="Cloudflare API token (hidden)"
  (( have_stored )) && token_label="Cloudflare API token (hidden; press Enter to reuse the saved token)"

  new_tok="" reuse=0 attempts=0
  while (( attempts < 3 )); do
    ask_secret answer "$token_label"
    if [[ -z "$answer" ]] && (( have_stored )); then
      reuse=1
      break
    fi
    if [[ "$answer" =~ [[:space:]] ]] || [[ "$answer" =~ [[:cntrl:]] ]]; then
      log_warn "Token must not contain whitespace or control characters."
      attempts=$(( attempts + 1 )); continue
    fi
    if (( ${#answer} < 20 || ${#answer} > 256 )); then
      log_warn "That doesn't look like a Cloudflare API token (expected 20-256 characters)."
      attempts=$(( attempts + 1 )); continue
    fi
    new_tok="$answer"
    break
  done
  if [[ -z "$new_tok" ]] && (( ! reuse )); then
    log_warn "Could not get a usable Cloudflare API token after 3 attempts. Nothing was changed."
    log_warn "Retry with:  $RETRY_HINT"
    exit 0
  fi
  if (( reuse )); then
    tok="$(read_stored_token)"
    if [[ -z "$tok" ]]; then
      log_warn "No stored Cloudflare token could be read. Nothing was changed."
      log_warn "Retry with:  $RETRY_HINT"
      exit 0
    fi
  else
    tok="$new_tok"
  fi
fi

# --- from here, HTTPS_DOMAIN is a real, non-"none" domain --------------------
if ! https_domain_valid "$HTTPS_DOMAIN"; then
  log_warn "HTTPS_DOMAIN='$HTTPS_DOMAIN' is not a valid domain (lowercase FQDN, e.g. ai.example.com)."
  log_warn "Nothing was changed. Retry with:  $RETRY_HINT"
  exit 0
fi
if ! [[ "$HTTPS_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
  log_warn "HTTPS_EMAIL='$HTTPS_EMAIL' is not a valid email address."
  log_warn "Nothing was changed. Retry with:  $RETRY_HINT"
  exit 0
fi

domain="$HTTPS_DOMAIN"
email="$HTTPS_EMAIL"
cert_pre_existing=0
https_cert_present "$domain" && cert_pre_existing=1
domain_unchanged=0
[[ "$domain" == "$previous_domain" ]] && domain_unchanged=1

# A token given (or typed) this run always wins; otherwise fall back to
# whatever is already on disk from an earlier configure.
if [[ -z "$tok" ]] && cf_credentials_exist; then
  tok="$(read_stored_token)"
fi

if [[ -n "$tok" ]]; then
  if [[ "$tok" =~ [[:space:]] ]] || [[ "$tok" =~ [[:cntrl:]] ]]; then
    log_warn "CLOUDFLARE_API_TOKEN contains whitespace or control characters; ignoring it."
    tok=""
  elif (( ${#tok} < 20 || ${#tok} > 256 )); then
    log_warn "CLOUDFLARE_API_TOKEN doesn't look right (expected 20-256 characters); ignoring it."
    tok=""
  fi
fi

if [[ -z "$tok" ]]; then
  if (( cert_pre_existing )); then
    log_warn "No usable Cloudflare API token (env or stored credentials); skipping the DNS record check for $domain."
  else
    log_warn "No usable Cloudflare API token (env or stored credentials) — cannot obtain a certificate for $domain."
    log_warn "Nothing was changed. Retry with:"
    log_warn "    CLOUDFLARE_API_TOKEN=... $RETRY_HINT"
    exit 0
  fi
fi

zone_id="" zone_name=""
if [[ -n "$tok" ]]; then
  zone_line="$(find_zone "$domain")" || zone_line=""
  if [[ -z "$zone_line" ]]; then
    if (( cert_pre_existing )); then
      log_warn "Could not find a Cloudflare zone covering $domain with this token; skipping the DNS record check."
      log_warn "Check that its Zone Resources include the zone containing $domain, that its permission"
      log_warn "is Zone / DNS / Edit, and that it's an API token, not the Global API Key."
      tok=""
    else
      log_warn "Could not find a Cloudflare zone covering $domain with this token."
      log_warn "Check that its Zone Resources include the zone containing $domain, that its permission"
      log_warn "is Zone / DNS / Edit, and that it's an API token, not the Global API Key."
      log_warn "Retry:  $RETRY_HINT"
      exit 0
    fi
  else
    read -r zone_id zone_name <<<"$zone_line"
    log_ok "Cloudflare zone: $zone_name"
  fi
fi

apt_install "${PKGS_HTTPS[@]}"
as_root install -d -m 0700 "$LETSENCRYPT_DIR"

if [[ -n "$tok" ]]; then
  write_cf_credentials "$tok"
  log_ok "Wrote Cloudflare credentials to $HTTPS_CF_CREDENTIALS"

  our_ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  manage_dns_record "$domain" "$zone_id" "$our_ip"
  check_dns_resolution "$domain" "$our_ip"
fi

if (( ! cert_pre_existing )); then
  if [[ -z "$tok" ]]; then
    log_warn "No Cloudflare credentials to certify $domain with. Nothing was changed."
    log_warn "Retry with:  CLOUDFLARE_API_TOKEN=... $RETRY_HINT"
    exit 0
  fi
  log_info "Requesting a Let's Encrypt certificate for $domain (DNS-01 via Cloudflare)..."
  if as_root certbot certonly --dns-cloudflare \
       --dns-cloudflare-credentials "$HTTPS_CF_CREDENTIALS" \
       --dns-cloudflare-propagation-seconds "$HTTPS_DNS_PROPAGATION_SECONDS" \
       --cert-name "$domain" -d "$domain" \
       --agree-tos -m "$email" --non-interactive --keep-until-expiring; then
    log_ok "Obtained a certificate for $domain"
  else
    log_warn "certbot failed to obtain a certificate for $domain. Nothing else was changed."
    log_warn "The Cloudflare credentials were kept, so a retry will not need the token again."
    log_warn "Investigate (see $LOG_FILE), then retry:  $RETRY_HINT"
    exit 0
  fi
fi

if ! https_cert_present "$domain"; then
  log_warn "Still no certificate on disk for $domain after certbot. Nothing else was changed."
  log_warn "Retry with:  $RETRY_HINT"
  exit 0
fi

write_deploy_hook

if has_systemd && ! svc_is_enabled certbot.timer && ! svc_is_active certbot.timer; then
  log_warn "certbot.timer is not enabled — certificates will not renew automatically."
  log_warn "Enable it with:  sudo systemctl enable --now certbot.timer"
fi

setting_remember HTTPS_DOMAIN "$domain"
setting_remember HTTPS_EMAIL "$email"

need_nginx_rerun=0
(( ! cert_pre_existing )) && need_nginx_rerun=1
(( ! domain_unchanged )) && need_nginx_rerun=1

if (( need_nginx_rerun )); then
  if bash "$SCRIPTS_DIR/66-install-nginx.sh"; then
    log_ok "nginx re-configured for https://$domain/"
  else
    log_warn "Re-running the nginx step failed; run it yourself:  sudo $INSTALL_SH --only nginx"
  fi
else
  log_ok "Nothing changed for $domain; nginx already reflects it."
fi

if https_probe "$domain"; then
  log_ok "https://$domain/ is answering"
else
  log_warn "https://$domain/ is not answering yet."
  log_warn "If nginx was just reconfigured this can take a moment; otherwise check:  sudo $INSTALL_SH --only nginx"
fi

exit 0
