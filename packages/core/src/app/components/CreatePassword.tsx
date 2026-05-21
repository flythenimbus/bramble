import { ArrowLeft, Eye, EyeOff, Sparkles, RefreshCw, Plus, X } from "lucide-react";
import { useState } from "react";

interface CreatePasswordProps {
  onBack: () => void;
}

interface CustomField {
  id: string;
  key: string;
  value: string;
  type: "text" | "password";
  showValue?: boolean;
}

export function CreatePassword({ onBack }: CreatePasswordProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    username: "",
    password: "",
    url: "",
    notes: "",
  });
  const [customFields, setCustomFields] = useState<CustomField[]>([]);

  const [passwordStrength, setPasswordStrength] = useState(0);

  const handlePasswordChange = (value: string) => {
    setFormData({ ...formData, password: value });

    // Simple strength calculation
    let strength = 0;
    if (value.length >= 8) strength++;
    if (value.length >= 12) strength++;
    if (/[a-z]/.test(value) && /[A-Z]/.test(value)) strength++;
    if (/\d/.test(value)) strength++;
    if (/[^a-zA-Z0-9]/.test(value)) strength++;

    setPasswordStrength(Math.min(strength, 4));
  };

  const generatePassword = () => {
    const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?";
    let password = "";
    for (let i = 0; i < 16; i++) {
      password += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    handlePasswordChange(password);
  };

  const getStrengthColor = () => {
    if (passwordStrength === 0) return "bg-muted";
    if (passwordStrength <= 2) return "bg-destructive";
    if (passwordStrength === 3) return "bg-yellow-500";
    return "bg-primary";
  };

  const getStrengthText = () => {
    if (passwordStrength === 0) return "No password";
    if (passwordStrength <= 2) return "Weak";
    if (passwordStrength === 3) return "Good";
    return "Strong";
  };

  const addCustomField = () => {
    setCustomFields([
      ...customFields,
      { id: Date.now().toString(), key: "", value: "", type: "text", showValue: false }
    ]);
  };

  const removeCustomField = (id: string) => {
    setCustomFields(customFields.filter(field => field.id !== id));
  };

  const updateCustomField = (id: string, updates: Partial<CustomField>) => {
    setCustomFields(customFields.map(field =>
      field.id === id ? { ...field, ...updates } : field
    ));
  };

  const toggleCustomFieldVisibility = (id: string) => {
    setCustomFields(customFields.map(field =>
      field.id === id ? { ...field, showValue: !field.showValue } : field
    ));
  };

  return (
    <main className="max-w-5xl mx-auto px-4 py-5">
      {/* Back button */}
      <button
        onClick={onBack}
        className="flex items-center gap-2 mb-4 text-sm text-muted-foreground hover:text-foreground active:scale-[0.98] transition-all"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to passwords
      </button>

      {/* Form */}
      <div>
        <div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
          <div className="p-6 space-y-5">
            {/* Name */}
            <div>
              <label className="block text-sm mb-2">Name</label>
              <input
                type="text"
                placeholder="e.g., Gmail, GitHub, Netflix"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
              />
            </div>

            {/* URL */}
            <div>
              <label className="block text-sm mb-2">Website URL</label>
              <input
                type="url"
                placeholder="https://example.com"
                value={formData.url}
                onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
              />
            </div>

            {/* Username */}
            <div>
              <label className="block text-sm mb-2">Username or Email</label>
              <input
                type="text"
                placeholder="username@example.com"
                value={formData.username}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
              />
            </div>

            {/* Password */}
            <div>
              <label className="block text-sm mb-2">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter a strong password"
                  value={formData.password}
                  onChange={(e) => handlePasswordChange(e.target.value)}
                  className="w-full px-3 py-2 pr-24 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
                />
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={generatePassword}
                    className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
                    aria-label="Generate password"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {/* Password Strength */}
              {formData.password && (
                <div className="mt-2.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs text-muted-foreground">Password strength</span>
                    <span className={`text-xs ${passwordStrength >= 3 ? 'text-primary' : passwordStrength === 0 ? 'text-muted-foreground' : 'text-destructive'}`}>
                      {getStrengthText()}
                    </span>
                  </div>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${getStrengthColor()}`}
                      style={{ width: `${(passwordStrength / 4) * 100}%` }}
                    />
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={generatePassword}
                className="mt-3 flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg border border-primary/50 bg-primary/5 text-primary hover:bg-primary/10 active:scale-[0.98] transition-all"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Generate Strong Password
              </button>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm mb-2">Notes (Optional)</label>
              <textarea
                placeholder="Add any additional information..."
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                rows={4}
                className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all resize-none"
              />
            </div>

            {/* Custom Fields */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm">Custom Fields</label>
                <button
                  type="button"
                  onClick={addCustomField}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all"
                >
                  <Plus className="w-3 h-3" />
                  Add Field
                </button>
              </div>

              {customFields.length > 0 && (
                <div className="space-y-3">
                  {customFields.map((field) => (
                    <div key={field.id} className="p-3 rounded-lg border border-border/50 bg-background/30">
                      <div className="flex gap-2 items-start mb-2">
                        <input
                          type="text"
                          placeholder="Field name"
                          value={field.key}
                          onChange={(e) => updateCustomField(field.id, { key: e.target.value })}
                          className="flex-1 px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
                        />
                        <select
                          value={field.type}
                          onChange={(e) => updateCustomField(field.id, { type: e.target.value as "text" | "password" })}
                          className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
                        >
                          <option value="text">Visible</option>
                          <option value="password">Hidden</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => removeCustomField(field.id)}
                          className="p-2 rounded-lg border border-transparent hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 active:scale-[0.95] transition-all"
                          aria-label="Remove field"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="relative">
                        <input
                          type={field.type === "password" && !field.showValue ? "password" : "text"}
                          placeholder="Value"
                          value={field.value}
                          onChange={(e) => updateCustomField(field.id, { value: e.target.value })}
                          className="w-full px-3 py-2 pr-10 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
                        />
                        {field.type === "password" && (
                          <button
                            type="button"
                            onClick={() => toggleCustomFieldVisibility(field.id)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
                            aria-label={field.showValue ? "Hide value" : "Show value"}
                          >
                            {field.showValue ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {customFields.length === 0 && (
                <p className="text-xs text-muted-foreground">Add custom fields to store additional information like security questions, account numbers, etc.</p>
              )}
            </div>
          </div>

          {/* Footer Actions */}
          <div className="px-6 py-4 bg-muted/30 border-t border-border/50 flex items-center justify-between">
            <button
              onClick={onBack}
              className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-background/50 active:scale-[0.98] transition-all"
            >
              Cancel
            </button>
            <button
              className="px-5 py-2 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all"
            >
              Save Password
            </button>
          </div>
        </div>

        {/* Tips Card */}
        <div className="mt-4 p-4 rounded-lg border border-border/50 bg-card/30 backdrop-blur-sm">
          <h4 className="text-sm mb-2 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            Tips for strong passwords
          </h4>
          <ul className="text-xs text-muted-foreground space-y-1">
            <li>• Use at least 12 characters</li>
            <li>• Mix uppercase and lowercase letters</li>
            <li>• Include numbers and special characters</li>
            <li>• Avoid common words and personal information</li>
          </ul>
        </div>
      </div>
    </main>
  );
}
