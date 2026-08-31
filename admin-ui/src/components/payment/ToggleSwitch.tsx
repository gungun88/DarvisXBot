type ToggleSwitchProps = {
  label?: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
};

export function ToggleSwitch({ label, checked, disabled = false, onToggle }: ToggleSwitchProps) {
  const control = (
    <label className="switch">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} aria-label={label} />
      <span />
    </label>
  );
  if (!label) return control;
  return (
    <span className="toggle-switch">
      <small>{label}</small>
      {control}
    </span>
  );
}
