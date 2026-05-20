import { useState } from "react";
import { Search, Settings, Moon, Sun, Shield, Filter, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { PasswordItem } from "./components/PasswordItem";
import { AddDropdown } from "./components/AddDropdown";
import { CreatePassword } from "./components/CreatePassword";

export default function App() {
  const [darkMode, setDarkMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentView, setCurrentView] = useState<"home" | "create-password">("home");

  const passwords = [
    { id: 1, name: "Gmail", username: "john.doe@gmail.com", url: "mail.google.com" },
    { id: 2, name: "GitHub", username: "johndoe", url: "github.com" },
    { id: 3, name: "Netflix", username: "john.doe@gmail.com", url: "netflix.com" },
    { id: 4, name: "LinkedIn", username: "john-doe", url: "linkedin.com" },
    { id: 5, name: "Amazon", username: "john.doe@gmail.com", url: "amazon.com" },
    { id: 6, name: "Spotify", username: "johndoe", url: "spotify.com" },
    { id: 7, name: "Twitter", username: "@johndoe", url: "twitter.com" },
    { id: 8, name: "Dropbox", username: "john.doe@gmail.com", url: "dropbox.com" },
    { id: 9, name: "Slack", username: "johndoe", url: "slack.com" },
    { id: 10, name: "Notion", username: "john.doe@gmail.com", url: "notion.so" },
  ];

  const filteredPasswords = passwords.filter(
    (pwd) =>
      pwd.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      pwd.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
      pwd.url?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const toggleTheme = () => {
    setDarkMode(!darkMode);
    document.documentElement.classList.toggle("dark");
  };

  return (
    <div className={darkMode ? "dark" : ""}>
      <div className="h-screen flex flex-col bg-gradient-to-br from-background via-background to-primary/5">
        {/* Header */}
        <header className="shrink-0 backdrop-blur-xl bg-background/80 border-b border-border/50 z-40">
          <div className="max-w-5xl mx-auto px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-primary/80 shadow-lg shadow-primary/25">
                  <Shield className="w-4.5 h-4.5 text-primary-foreground" />
                </div>
                <h1 className="text-lg bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">PassGuard</h1>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  onClick={toggleTheme}
                  className="p-2 rounded-lg border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
                  aria-label="Toggle theme"
                >
                  {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                </button>
                <button
                  className="p-2 rounded-lg border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
                  aria-label="Settings"
                >
                  <Settings className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </header>

        {/* Main Content */}
        {currentView === "create-password" ? (
          <div className="flex-1 overflow-y-auto">
            <CreatePassword onBack={() => setCurrentView("home")} />
          </div>
        ) : (
          <main className="flex-1 min-h-0 flex flex-col w-full max-w-5xl mx-auto px-4 py-5">
          {/* Search and Actions */}
          <div className="flex gap-2 mb-5">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
              <input
                type="text"
                placeholder="Search passwords..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
              />
            </div>
            <button className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-border bg-card/50 backdrop-blur-sm hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all">
              <Filter className="w-4 h-4" />
              Filter
            </button>
            <AddDropdown onCreatePassword={() => setCurrentView("create-password")} />
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-3 mb-5">
            <div className="relative overflow-hidden px-4 py-3 rounded-lg border border-border/50 bg-gradient-to-br from-card/80 to-card/50 backdrop-blur-sm">
              <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-50"></div>
              <div className="relative">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <p className="text-xs text-muted-foreground">Total Items</p>
                </div>
                <p className="text-2xl">{passwords.length}</p>
              </div>
            </div>
            <div className="relative overflow-hidden px-4 py-3 rounded-lg border border-border/50 bg-gradient-to-br from-card/80 to-card/50 backdrop-blur-sm">
              <div className="absolute inset-0 bg-gradient-to-br from-destructive/5 to-transparent opacity-50"></div>
              <div className="relative">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <p className="text-xs text-muted-foreground">At Risk</p>
                  <TrendingDown className="w-3 h-3 text-destructive" />
                </div>
                <p className="text-2xl text-destructive">2</p>
              </div>
            </div>
            <div className="relative overflow-hidden px-4 py-3 rounded-lg border border-border/50 bg-gradient-to-br from-card/80 to-card/50 backdrop-blur-sm">
              <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-50"></div>
              <div className="relative">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <p className="text-xs text-muted-foreground">Strong</p>
                  <TrendingUp className="w-3 h-3 text-primary" />
                </div>
                <p className="text-2xl text-primary">8</p>
              </div>
            </div>
          </div>

          {/* Password List */}
          <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
            <div className="shrink-0 px-4 py-3 border-b border-border/50 flex items-center justify-between">
              <h3 className="text-sm">Passwords ({filteredPasswords.length})</h3>
              <button className="text-xs text-muted-foreground hover:text-foreground active:scale-[0.98] transition-all">
                Sort by name
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
              {filteredPasswords.length > 0 ? (
                filteredPasswords.map((pwd) => (
                  <PasswordItem
                    key={pwd.id}
                    name={pwd.name}
                    username={pwd.username}
                    url={pwd.url}
                  />
                ))
              ) : (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  No passwords found matching your search.
                </div>
              )}
            </div>
          </div>
        </main>
        )}
      </div>
    </div>
  );
}