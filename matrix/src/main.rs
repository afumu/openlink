use clap::{Parser, Subcommand};
use ratatui::{prelude::*, widgets::*};
use crossterm::event::{self, Event, KeyCode};
use serde::{Deserialize, Serialize};
use std::fs::{OpenOptions, File};
use std::io::{BufRead, BufReader, Write};
const DATA_FILE: &str = "todos.json";
#[derive(Serialize, Deserialize, Clone)]

struct Task {

id: String,

content: String,

status: String,

priority: String,

created: String,

tags: Vec<String>,

due: Option<String>,

}
#[derive(Parser)]

struct Cli {

#[command(subcommand)]

command: Option<Commands>,

}
#[derive(Subcommand)]

enum Commands {

List,

Add { content: String },

Done { id: String },

Tui,

}
fn main() -> Result<(), Box<dyn std::error::Error>> {

let cli = Cli::parse();



text

match &amp;cli.command {
    Some(Commands::List) =&gt; list_tasks(),
    Some(Commands::Add { content }) =&gt; add_task(content),
    Some(Commands::Done { id }) =&gt; done_task(id),
    Some(Commands::Tui) | None =&gt; run_tui(),
}
}
fn load_tasks() -> Vec<Task> {

let file = File::open(DATA_FILE).unwrap_or_else(|_| File::create(DATA_FILE).unwrap());

let reader = BufReader::new(file);

reader.lines().filter_map(|l| serde_json::from_str(&l.ok()?).ok()).collect()

}
fn save_task(task: &Task) {

let mut file = OpenOptions::new().append(true).create(true).open(DATA_FILE).unwrap();

writeln!(file, "{}", serde_json::to_string(task).unwrap()).unwrap();

}
fn list_tasks() {

for task in load_tasks() {

if task.status == "pending" {

println!("{} [{}] {}", task.id, task.priority, task.content);

}

}

}
fn add_task(content: &str) {

let task = Task {

id: format!("m{}", chrono::Local::now().format("%Y%m%d-%H%M")),

content: content.to_string(),

status: "pending".to_string(),

priority: "medium".to_string(),

created: chrono::Local::now().to_rfc3339(),

tags: vec![],

due: None,

};

save_task(&task);

println!("添加: {} {}", task.id, content);

}
fn done_task(id: &str) {

// 简易实现：直接重新写入所有未完成任务（原型足够）

let tasks = load_tasks();

std::fs::write(DATA_FILE, "").unwrap();

for mut task in tasks {

if task.id == id {

task.status = "done".to_string();

}

if task.status == "pending" {

save_task(&task);

}

}

println!("完成: {}", id);

}
fn run_tui() -> Result<(), Box<dyn std::error::Error>> {

let mut terminal = ratatui::init();

let mut tasks = load_tasks();



text

loop {
    terminal.draw(|f| {
        let chunks = Layout::default().direction(Direction::Vertical)
            .constraints([Constraint::Min(3), Constraint::Length(3)])
            .split(f.area());

        let items: Vec&lt;ListItem&gt; = tasks.iter().filter(|t| t.status == "pending")
            .map(|t| ListItem::new(format!("{}  {}  {}", t.id, t.priority, t.content)))
            .collect();

        let list = List::new(items).block(Block::default().title("Matrix").borders(Borders::ALL));
        f.render_widget(list, chunks[0]);

        let help = Paragraph::new("q:退出  n:新建  d:完成")
            .style(Style::default().fg(Color::Gray));
        f.render_widget(help, chunks[1]);
    })?;

    if let Event::Key(key) = event::read()? {
        match key.code {
            KeyCode::Char('q') =&gt; break,
            KeyCode::Char('n') =&gt; {
                // 简化：直接用 println 输入
                println!("输入任务内容:");
                let mut input = String::new();
                std::io::stdin().read_line(&amp;mut input).unwrap();
                add_task(&amp;input.trim());
                tasks = load_tasks();
            }
            _ =&gt; {}
        }
    }
}
ratatui::restore();
Ok(())
}

