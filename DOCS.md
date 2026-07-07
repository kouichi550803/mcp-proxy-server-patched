# MCP Proxy Server Home Assistant Add-on

This add-on integrates the MCP Proxy Server into Home Assistant, allowing you to manage and proxy multiple Model Context Protocol (MCP) servers through a unified interface.

## About

The MCP Proxy Server acts as a central hub for your MCP resource servers. Key features include:

*   **Web UI Management**: Easily manage all connected MCP servers (Stdio and SSE types) through an intuitive web interface.
*   **Granular Tool Control**: Enable or disable individual tools from backend servers and override their display names/descriptions.
*   **SSE Authentication**: Secure the proxy's SSE endpoint.
*   **Real-time Installation Output**: Monitor Stdio server installation progress directly in the Web UI.
*   **Web Terminal**: Access a command-line terminal within the Admin UI for direct server interaction (use with caution).

This add-on exposes these features within your Home Assistant environment.

## Configuration

| Option                         | Type    | Default Value        | Description                                                                                                                               |
| ------------------------------ | ------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `port`                         | integer | `3673`                | The network port on which the MCP Proxy Server's SSE endpoint and Admin Web UI will be accessible.                                        |
| `enable_admin_ui`              | boolean | `true`               | Set to `true` to enable the Admin Web UI.                                                            |
| `admin_username`               | string  | `admin`              | Username for accessing the Admin Web UI.                                                     |
| `admin_password`               | password| `password`           | Password for accessing the Admin Web UI. **Change this.**                         |
| `tools_folder`                 | string  | `/share/mcp_tools_patched`   | Base directory for Stdio MCP server installs via Admin UI.                       |

## Patches vs upstream

See the repository README for the list of independent fixes applied on top of ptbsare/mcp-proxy-server 0.4.1.
