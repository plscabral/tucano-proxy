#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Claude Desktop (and any stdio-only MCP client) spawns us as
    // `tucano-proxy mcp-stdio` to bridge to the running app's HTTP /mcp
    // endpoint. Handle that before booting the Tauri GUI.
    if std::env::args().nth(1).as_deref() == Some("mcp-stdio") {
        tucano_lib::run_mcp_stdio();
        return;
    }
    tucano_lib::run();
}
