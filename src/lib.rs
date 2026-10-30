use std::{env, fs, path::PathBuf};

use zed_extension_api::{
    self as zed, LanguageServerId, Result, SlashCommand, SlashCommandOutput,
    SlashCommandOutputSection, Worktree,
};

const SERVER_JS_SOURCE: &str = include_str!("../server.js");

struct WebServerExtension {
    node_path: Option<String>,
    server_js_path: Option<String>,
}

impl WebServerExtension {
    fn ext_dir() -> Result<PathBuf> {
        env::var("PWD")
            .map(PathBuf::from)
            .or_else(|_| env::current_dir().map_err(|e| e.to_string()))
            .map_err(|e| format!("failed to determine extension directory: {}", e))
    }

    fn ensure_server_js(&mut self) -> Result<String> {
        if let Some(ref path) = self.server_js_path {
            if PathBuf::from(path).exists() {
                return Ok(path.clone());
            }
        }

        let dir = Self::ext_dir()?;
        let server_js = dir.join("server.js");

        fs::write(&server_js, SERVER_JS_SOURCE)
            .map_err(|e| format!("failed to write server.js: {}", e))?;

        let path = server_js.to_string_lossy().to_string();
        self.server_js_path = Some(path.clone());
        Ok(path)
    }

    fn ensure_node_path(&mut self) -> Result<String> {
        if let Some(ref path) = self.node_path {
            return Ok(path.clone());
        }
        let path = zed::node_binary_path().unwrap_or_else(|_| "node".to_string());
        self.node_path = Some(path.clone());
        Ok(path)
    }
}

impl zed::Extension for WebServerExtension {
    fn new() -> Self {
        Self {
            node_path: None,
            server_js_path: None,
        }
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<zed::Command> {
        let node_path = self.ensure_node_path()?;
        let server_js = self.ensure_server_js()?;
        let root_path = worktree.root_path();

        Ok(zed::Command {
            command: node_path,
            args: vec![server_js, root_path],
            env: Default::default(),
        })
    }

    fn run_slash_command(
        &self,
        command: SlashCommand,
        _args: Vec<String>,
        worktree: Option<&Worktree>,
    ) -> Result<SlashCommandOutput, String> {
        let root_path = worktree.map(|w| w.root_path()).unwrap_or_default();

        match command.name.as_str() {
            "webserver-start" => {
                let launch_url = "http://localhost:5500";

                let (program, shell_args) = match zed::current_platform() {
                    (zed::Os::Mac, _) => ("open", vec![launch_url.to_string()]),
                    (zed::Os::Linux, _) => ("xdg-open", vec![launch_url.to_string()]),
                    (zed::Os::Windows, _) => (
                        "cmd",
                        vec![
                            "/C".to_string(),
                            "start".to_string(),
                            "".to_string(),
                            launch_url.to_string(),
                        ],
                    ),
                };

                let mut cmd = zed::process::Command::new(program).args(shell_args);
                let _ = cmd.output();

                let text = format!(
                    "Start Life — launching live server...\n\nOpening browser at:\n  {}\n\nThe server starts automatically. If the page doesn't load, wait a few seconds and refresh.\n\nCommands:\n  /webserver-status  Check server status\n  /webserver-stop    Stop server",
                    launch_url
                );
                Ok(SlashCommandOutput {
                    text: text.clone(),
                    sections: vec![SlashCommandOutputSection {
                        range: (0..text.len()).into(),
                        label: "Start Life".to_string(),
                    }],
                })
            }
            "webserver-status" => {
                let text = format!(
                    "WebServer — Live Server Status\n\nServer:  http://localhost:5500\nRoot:  {}\n\nThe server starts automatically when you open an HTML file.\n\nCommands:\n  /webserver-open    Open browser\n  /webserver-stop    Stop server",
                    root_path
                );
                Ok(SlashCommandOutput {
                    text: text.clone(),
                    sections: vec![SlashCommandOutputSection {
                        range: (0..text.len()).into(),
                        label: "WebServer".to_string(),
                    }],
                })
            }
            "webserver-open" => {
                let launch_url = "http://localhost:5500";

                let (program, shell_args) = match zed::current_platform() {
                    (zed::Os::Mac, _) => ("open", vec![launch_url.to_string()]),
                    (zed::Os::Linux, _) => ("xdg-open", vec![launch_url.to_string()]),
                    (zed::Os::Windows, _) => (
                        "cmd",
                        vec![
                            "/C".to_string(),
                            "start".to_string(),
                            "".to_string(),
                            launch_url.to_string(),
                        ],
                    ),
                };

                let mut cmd = zed::process::Command::new(program).args(shell_args);
                let _ = cmd.output();

                let text = format!(
                    "Opening WebServer in your browser...\n\nURL: {}\n\nIf the browser doesn't open automatically, copy the URL above and paste it in your browser.\n\nNote: You may need to accept the self-signed certificate the first time.",
                    launch_url
                );
                Ok(SlashCommandOutput {
                    text: text.clone(),
                    sections: vec![SlashCommandOutputSection {
                        range: (0..text.len()).into(),
                        label: "WebServer - Open Browser".to_string(),
                    }],
                })
            }
            "webserver-stop" => {
                let (program, shell_args) = match zed::current_platform() {
                    (zed::Os::Mac, _) | (zed::Os::Linux, _) => (
                        "sh",
                        vec![
                            "-c".to_string(),
                            "lsof -ti:5500 | xargs -r kill 2>/dev/null; true".to_string(),
                        ],
                    ),
                    (zed::Os::Windows, _) => (
                        "cmd",
                        vec![
                            "/C".to_string(),
                            "echo WebServer stopped. Close the project or disable the WebServer language server in settings.".to_string(),
                        ],
                    ),
                };

                let mut cmd = zed::process::Command::new(program).args(shell_args);
                let _ = cmd.output();

                let text = "Stopping WebServer...\n\nThe WebServer has been stopped.\n\nTo start again, open an HTML file or run /webserver-start.".to_string();
                Ok(SlashCommandOutput {
                    text: text.clone(),
                    sections: vec![SlashCommandOutputSection {
                        range: (0..text.len()).into(),
                        label: "WebServer - Stop".to_string(),
                    }],
                })
            }
            "webserver-reopen" => {
                let (program, shell_args) = match zed::current_platform() {
                    (zed::Os::Mac, _) | (zed::Os::Linux, _) => (
                        "sh",
                        vec![
                            "-c".to_string(),
                            "lsof -ti:5500 | xargs -r kill 2>/dev/null; sleep 1; true".to_string(),
                        ],
                    ),
                    (zed::Os::Windows, _) => (
                        "cmd",
                        vec![
                            "/C".to_string(),
                            "echo WebServer restarting...".to_string(),
                        ],
                    ),
                };

                let mut cmd = zed::process::Command::new(program).args(shell_args);
                let _ = cmd.output();

                let launch_url = "http://localhost:5500";
                let (open_program, open_args) = match zed::current_platform() {
                    (zed::Os::Mac, _) => ("open", vec![launch_url.to_string()]),
                    (zed::Os::Linux, _) => ("xdg-open", vec![launch_url.to_string()]),
                    (zed::Os::Windows, _) => (
                        "cmd",
                        vec![
                            "/C".to_string(),
                            "start".to_string(),
                            "".to_string(),
                            launch_url.to_string(),
                        ],
                    ),
                };

                let mut open_cmd = zed::process::Command::new(open_program).args(open_args);
                let _ = open_cmd.output();

                let text = format!(
                    "Restarting WebServer...\n\nServer restarted at: {}\n\nThe server has been restarted. Wait a few seconds for it to come online.\n\nCommands:\n  /webserver-start  Open browser\n  /webserver-stop   Stop server\n  /webserver-status Check status",
                    launch_url
                );
                Ok(SlashCommandOutput {
                    text: text.clone(),
                    sections: vec![SlashCommandOutputSection {
                        range: (0..text.len()).into(),
                        label: "WebServer - Restart".to_string(),
                    }],
                })
            }
            _ => Err(format!("Unknown slash command: {}", command.name)),
        }
    }
}

zed::register_extension!(WebServerExtension);
