import { useState, useRef, useEffect } from "react";
import { Plus, Key, CreditCard, FileText, Folder, ChevronDown } from "lucide-react";

interface AddDropdownProps {
  onCreatePassword: () => void;
}

export function AddDropdown({ onCreatePassword }: AddDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleItemClick = (type: string) => {
    setIsOpen(false);
    if (type === "password") {
      onCreatePassword();
    }
  };

  const items = [
    { type: "password", icon: Key, label: "Password", description: "Add a new password" },
    { type: "card", icon: CreditCard, label: "Payment Card", description: "Credit or debit card" },
    { type: "note", icon: FileText, label: "Secure Note", description: "Store sensitive text" },
    { type: "folder", icon: Folder, label: "Folder", description: "Organize your items" },
  ];

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all"
      >
        <Plus className="w-4 h-4" />
        <span className="text-sm">Add New</span>
        <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 rounded-lg border border-border/50 bg-card shadow-xl shadow-black/10 overflow-hidden z-50">
          {items.map((item, index) => (
            <button
              key={index}
              onClick={() => handleItemClick(item.type)}
              className="w-full flex items-start gap-3 px-4 py-3 hover:bg-primary/5 transition-colors text-left border-b border-border/30 last:border-b-0"
            >
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 mt-0.5">
                <item.icon className="w-4 h-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm">{item.label}</p>
                <p className="text-xs text-muted-foreground">{item.description}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
