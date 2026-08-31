import { Pencil, Server, Trash2 } from "lucide-react";
import type { PaymentProvider } from "../../types";
import { providerLabel, typeLabel } from "./providerConfig";
import { ToggleSwitch } from "./ToggleSwitch";

type ProviderCardProps = {
  provider: PaymentProvider;
  onEdit: () => void;
  onDelete: () => void;
  onToggleField: (field: "enabled" | "refundEnabled") => void;
  onToggleType: (type: string) => void;
};

export function ProviderCard({ provider, onEdit, onDelete, onToggleField, onToggleType }: ProviderCardProps) {
  const merchantId = provider.config.pid || provider.config.appId || provider.config.clientId || provider.config.mchId || "";
  return (
    <div className={`provider-card ${provider.enabled ? "" : "is-disabled"}`}>
      <div className="provider-card-main">
        <span className={`provider-icon ${provider.enabled ? "is-on" : ""}`}><Server size={16} /></span>
        <strong>{provider.name}</strong>
        <small>{providerLabel(provider.providerKey)}</small>
        <span className="provider-divider" />
        <div className="type-chips">
          {provider.supportedTypes.map((type) => (
            <button key={type} type="button" className="type-chip active" title="点击停用该支付方式" onClick={() => onToggleType(type)}>
              {typeLabel(type)}
            </button>
          ))}
        </div>
      </div>
      <div className="provider-card-side">
        <div className="provider-meta">
          <span>商户 ID：{merchantId || "未配置"}</span>
          <span>密钥状态：{provider.secretConfigured ? "已配置" : "未配置"}</span>
          <span>回调地址：{provider.config.notifyUrl || "未配置"}</span>
        </div>
        <div className="provider-controls">
          <ToggleSwitch label="已启用" checked={provider.enabled} onToggle={() => onToggleField("enabled")} />
          {provider.providerKey === "easypay" && (
            <ToggleSwitch label="允许退款" checked={provider.refundEnabled} onToggle={() => onToggleField("refundEnabled")} />
          )}
          <div className="provider-actions">
            <button className="icon-button small" title="编辑" onClick={onEdit}><Pencil size={15} /></button>
            <button className="icon-button small danger-button" title="删除" onClick={onDelete}><Trash2 size={15} /></button>
          </div>
        </div>
      </div>
    </div>
  );
}
