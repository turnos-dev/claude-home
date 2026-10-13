# Install this temporary Pi fork

Repository: **https://github.com/turnos-dev/claude-home**
Add-on version: **0.18.0**. Requires **Home Assistant OS or Supervised**, HA 2025.8+.

## Fresh installation

1. In HA, go to Settings → Devices & services → Add integration →
   **Model Context Protocol Server**. Under Settings → Voice assistants → Expose,
   expose the devices your assistant may control.
2. Go to Settings → Add-ons → Add-on Store → ⋮ → Repositories. Add:
   `https://github.com/turnos-dev/claude-home`
   Then install **Claude Home** from **Claude Home (Pi fork)**. Builds locally;
   allow several minutes. Start it, enable Start on boot and Show in sidebar.
3. In HACS → ⋮ → Custom repositories, add the same URL with type **Integration**.
   Download **Claude Home**, then restart HA. If you already have the upstream
   integration, it is compatible with this fork and need not be replaced.
4. Under Settings → Devices & services, configure **Claude Home discovered**.
   If discovery does not appear, restart the add-on. Manual setup uses its Info
   tab's Hostname, port `8099`, and the API token printed in the add-on log.
5. Under Settings → Voice assistants → your assistant, select **Claude Home**
   as Conversation agent. Keep Prefer handling commands locally enabled.
6. In the Claude sidebar → Settings, select **Other providers (Pi SDK)**,
   choose a provider/model and Save. Then connect the **Pi provider account**
   with its subscription login (Codex/Copilot) or an API key.
   For Claude instead, retain **Claude Code** and use **Claude account**.

## If upstream Claude Home is already installed

Take a backup first. A fork repository generally installs as a **separate add-on**
with separate storage; existing logins, options and histories do not migrate
automatically. Stop the original add-on and disable its Start on boot before
starting this fork. Do not run both: discovery uses the same integration ID and
could switch its endpoint back and forth.

Keep the existing HACS integration. The fork's discovery should update its host
and token; reload that integration (or restart HA) afterward. If discovery fails,
remove/re-add the integration using the fork add-on's hostname and API token,
then reselect the conversation agent. Log in again and reapply settings in the
fork. Keep the old add-on installed/stopped until you are happy with the fork.

## Updates

Refresh/check for updates in the Add-on Store. When this fork publishes a new
add-on version, use **Update** on its add-on page (back up first). Existing fork
credentials and histories are retained in `/data`. Integration updates, if any,
are handled separately through HACS and may require an HA restart.

Local backend and browser tests passed. Live provider authorization and Home
Assistant/device control still need validation on your installation. Provider
subscription access is subject to the provider's terms and limits.
