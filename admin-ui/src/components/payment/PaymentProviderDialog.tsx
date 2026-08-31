import { ChevronDown, Eye, EyeOff, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PaymentProvider } from "../../types";
import {
  PAYMENT_CURRENCY_OPTIONS,
  PROVIDER_CALLBACK_PATHS,
  PROVIDER_CONFIG_FIELDS,
  PROVIDER_KEYS,
  PROVIDER_SUPPORTED_TYPES,
  providerLabel,
  providerWebhookUrl,
  typeLabel,
  webhookNote
} from "./providerConfig";
import { ToggleSwitch } from "./ToggleSwitch";

export type ProviderSavePayload = {
  providerKey: string;
  name: string;
  supportedTypes: string[];
  enabled: boolean;
  refundEnabled: boolean;
  config: Record<string, string>;
  limits: string;
  publicBaseUrl: string;
  sortOrder?: number;
};

type Props = {
  show: boolean;
  saving: boolean;
  editing: PaymentProvider | null;
  onClose: () => void;
  onSave: (payload: ProviderSavePayload) => void;
};

type LimitDraft = { singleMin: string; singleMax: string };

function emptyLimitDraft(): LimitDraft {
  return { singleMin: "", singleMax: "" };
}

function maskSecretValue(value: string) {
  return value.replace(/[^\r\n]/g, "•");
}

function normalizeLimitDrafts(providerKey: string, value: PaymentProvider["limits"] | undefined): Record<string, LimitDraft> {
  const result: Record<string, LimitDraft> = {};
  for (const type of PROVIDER_SUPPORTED_TYPES[providerKey] ?? []) result[type] = emptyLimitDraft();
  if (providerKey === "stripe") result.stripe = result.stripe ?? emptyLimitDraft();
  if (!value) return result;
  for (const key of Object.keys(result)) {
    const rule = value[key];
    if (!rule) continue;
    result[key] = {
      singleMin: rule.singleMin === undefined ? "" : String(rule.singleMin),
      singleMax: rule.singleMax === undefined ? "" : String(rule.singleMax)
    };
  }
  return result;
}

function serializeLimits(limits: Record<string, LimitDraft>): string {
  const result: Record<string, Record<string, number>> = {};
  for (const [method, draft] of Object.entries(limits)) {
    const rule: Record<string, number> = {};
    for (const key of ["singleMin", "singleMax"] as const) {
      const raw = draft[key];
      const value = Number(raw);
      if (raw !== "" && Number.isFinite(value) && value >= 0) rule[key] = value;
    }
    if (Object.keys(rule).length) result[method] = rule;
  }
  return Object.keys(result).length ? JSON.stringify(result) : "";
}

function extractBaseUrl(fullUrl: string, path: string) {
  if (!fullUrl) return "";
  if (fullUrl.endsWith(path)) return fullUrl.slice(0, -path.length);
  try {
    return new URL(fullUrl).origin;
  } catch {
    return fullUrl;
  }
}

export function PaymentProviderDialog({ show, saving, editing, onClose, onSave }: Props) {
  const [name, setName] = useState("");
  const [providerKey, setProviderKey] = useState("easypay");
  const [enabled, setEnabled] = useState(true);
  const [refundEnabled, setRefundEnabled] = useState(false);
  const [supportedTypes, setSupportedTypes] = useState<string[]>(PROVIDER_SUPPORTED_TYPES.easypay);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [limits, setLimits] = useState<Record<string, LimitDraft>>({});
  const [notifyBaseUrl, setNotifyBaseUrl] = useState("");
  const [returnBaseUrl, setReturnBaseUrl] = useState("");
  const [visibleFields, setVisibleFields] = useState<Record<string, boolean>>({});
  const [limitsExpanded, setLimitsExpanded] = useState(false);

  const fields = PROVIDER_CONFIG_FIELDS[providerKey] ?? [];
  const callbackPaths = PROVIDER_CALLBACK_PATHS[providerKey] ?? null;
  const defaultBaseUrl = window.location.origin;
  const isEditing = Boolean(editing?.id);
  const providerWebhook = providerWebhookUrl(providerKey, notifyBaseUrl.trim() || defaultBaseUrl);

  useEffect(() => {
    if (!show) return;
    const source = editing;
    const nextKey = source?.providerKey ?? "easypay";
    const nextFields = PROVIDER_CONFIG_FIELDS[nextKey] ?? [];
    const nextCallbackPaths = PROVIDER_CALLBACK_PATHS[nextKey] ?? null;
    setName(source?.name ?? "");
    setProviderKey(nextKey);
    setEnabled(source?.enabled ?? true);
    setRefundEnabled(source?.refundEnabled ?? false);
    setSupportedTypes(source?.supportedTypes?.length ? [...source.supportedTypes] : [...(PROVIDER_SUPPORTED_TYPES[nextKey] ?? [])]);
    const nextConfig: Record<string, string> = {};
    for (const field of nextFields) {
      if (field.defaultValue) nextConfig[field.key] = field.defaultValue;
    }
    setVisibleFields({});
    setLimitsExpanded(false);
    setLimits(normalizeLimitDrafts(nextKey, source?.limits));
    setNotifyBaseUrl("");
    setReturnBaseUrl("");
    if (source?.config) {
      for (const [key, value] of Object.entries(source.config)) {
        if (value) nextConfig[key] = value;
      }
      if (nextCallbackPaths?.notifyUrl && source.config.notifyUrl) {
        setNotifyBaseUrl(extractBaseUrl(source.config.notifyUrl, nextCallbackPaths.notifyUrl));
      }
      if (nextCallbackPaths?.returnUrl && source.config.returnUrl) {
        setReturnBaseUrl(extractBaseUrl(source.config.returnUrl, nextCallbackPaths.returnUrl));
      }
    }
    setConfig(nextConfig);
  }, [editing, show]);

  const availableTypes = useMemo(
    () => (PROVIDER_SUPPORTED_TYPES[providerKey] ?? []).map((type) => ({ value: type, label: typeLabel(type) })),
    [providerKey]
  );

  const limitableTypes = useMemo(() => {
    if (providerKey === "stripe") return [{ value: "stripe", label: "Stripe" }];
    return supportedTypes.map((type) => ({ value: type, label: typeLabel(type) }));
  }, [providerKey, supportedTypes]);

  function updateField(key: string, value: string) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  function updateLimit(method: string, field: keyof LimitDraft, value: string) {
    setLimits((current) => ({ ...current, [method]: { ...(current[method] ?? emptyLimitDraft()), [field]: value } }));
  }

  function toggleType(type: string) {
    setSupportedTypes((current) => current.includes(type)
      ? current.length > 1 ? current.filter((item) => item !== type) : current
      : [...current, type]);
  }

  function handleProviderKeyChange(next: string) {
    setProviderKey(next);
    setSupportedTypes([...(PROVIDER_SUPPORTED_TYPES[next] ?? [])]);
    const nextConfig: Record<string, string> = {};
    for (const field of PROVIDER_CONFIG_FIELDS[next] ?? []) {
      if (field.defaultValue) nextConfig[field.key] = field.defaultValue;
    }
    setConfig(nextConfig);
    setLimits(normalizeLimitDrafts(next, undefined));
    setVisibleFields({});
    setNotifyBaseUrl("");
    setReturnBaseUrl("");
  }

  function handleSave() {
    const nextConfig: Record<string, string> = {};
    for (const field of fields) {
      const value = String(config[field.key] ?? "").trim();
      if (value) nextConfig[field.key] = value;
    }
    const notifyBase = (notifyBaseUrl.trim() || defaultBaseUrl).replace(/\/$/, "");
    const returnBase = (returnBaseUrl.trim() || defaultBaseUrl).replace(/\/$/, "");
    if (callbackPaths?.notifyUrl) nextConfig.notifyUrl = `${notifyBase}${callbackPaths.notifyUrl}`;
    if (callbackPaths?.returnUrl) nextConfig.returnUrl = `${returnBase}${callbackPaths.returnUrl}`;
    onSave({
      providerKey,
      name: name.trim(),
      supportedTypes,
      enabled,
      refundEnabled,
      config: nextConfig,
      limits: serializeLimits(limits),
      publicBaseUrl: notifyBase,
      ...(editing?.sortOrder !== undefined ? { sortOrder: editing.sortOrder } : {})
    });
  }

  if (!show) return null;

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal provider-modal">
        <div className="modal-header">
          <div>
            <h2>{isEditing ? "编辑服务商" : "添加服务商"}</h2>
            <p>{isEditing ? `${providerLabel(providerKey)} · #${editing?.id}` : "配置支付服务商凭证与回调地址"}</p>
          </div>
          <button className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        <form
          id="provider-form"
          className="form-stack provider-form"
          onSubmit={(event) => { event.preventDefault(); handleSave(); }}
        >
          <div className="provider-form-grid">
            <label>
              <span>服务商名称 *</span>
              <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={64} />
            </label>
            <label>
              <span>服务商类型 *</span>
              <select value={providerKey} disabled={isEditing} onChange={(event) => handleProviderKeyChange(event.target.value)}>
                {PROVIDER_KEYS.map((key) => <option key={key} value={key}>{providerLabel(key)}</option>)}
              </select>
            </label>
          </div>

          <div className="provider-flags">
            <ToggleSwitch label="已启用" checked={enabled} onToggle={() => setEnabled((value) => !value)} />
            {providerKey === "easypay" && (
              <ToggleSwitch label="允许退款" checked={refundEnabled} onToggle={() => setRefundEnabled((value) => !value)} />
            )}
            {availableTypes.length > 1 && (
              <div className="provider-type-picker">
                <span className="field-label">支持的支付方式</span>
                <div className="type-chips">
                  {availableTypes.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={`type-chip ${supportedTypes.includes(item.value) ? "active" : ""}`}
                      onClick={() => toggleType(item.value)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="form-section">
            <h3>凭证配置</h3>
            {providerKey === "alipay" && <small className="form-hint">需要支付宝开放平台「电脑网站支付」能力，密钥算法 RSA2。</small>}
            {providerKey === "wxpay" && <small className="form-hint">使用微信支付 API v3 Native 扫码下单，需要商户私钥与平台公钥。</small>}
            {providerKey === "airwallex" && <small className="form-hint">创建 Airwallex Scoped API 密钥时，建议只为 Payment Acceptance 勾选读取和写入。</small>}
            <div className="credential-stack">
              {fields.map((field) => {
                const value = config[field.key] ?? "";
                const isPassword = field.sensitive && field.type !== "textarea";
                const showTextArea = field.type === "textarea";
                const masked = field.sensitive && !visibleFields[field.key] && Boolean(value);
                const displayValue = masked && showTextArea ? maskSecretValue(value) : value;
                const toggleSecretButton = field.sensitive ? (
                  <button
                    type="button"
                    className="secret-toggle"
                    title={visibleFields[field.key] ? "隐藏" : "显示"}
                    onClick={() => setVisibleFields((current) => ({ ...current, [field.key]: !current[field.key] }))}
                  >
                    {visibleFields[field.key] ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                ) : null;
                return (
                  <label key={field.key}>
                    <span>{field.label} {field.optional ? <em className="form-optional">(可选)</em> : "*"}</span>
                    {showTextArea ? (
                      <div className="secret-input">
                        <textarea
                          rows={3}
                          value={displayValue}
                          readOnly={masked}
                          spellCheck={false}
                          autoComplete="new-password"
                          onChange={(event) => updateField(field.key, event.target.value)}
                        />
                        {toggleSecretButton}
                      </div>
                    ) : isPassword ? (
                      <div className="secret-input">
                        <input
                          type={visibleFields[field.key] ? "text" : "password"}
                          value={displayValue}
                          readOnly={masked}
                          spellCheck={false}
                          autoComplete="new-password"
                          onChange={(event) => updateField(field.key, event.target.value)}
                        />
                        {toggleSecretButton}
                      </div>
                    ) : field.type === "select" ? (
                      <select value={value || field.defaultValue || ""} onChange={(event) => updateField(field.key, event.target.value)}>
                        {(field.options ?? PAYMENT_CURRENCY_OPTIONS).map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input value={value} placeholder={field.defaultValue ?? ""} onChange={(event) => updateField(field.key, event.target.value)} />
                    )}
                  </label>
                );
              })}
            </div>

            {callbackPaths && (
              <div className="credential-stack callback-stack">
                <label>
                  <span>异步通知地址 *</span>
                  <div className="url-join">
                    <input value={notifyBaseUrl} placeholder={defaultBaseUrl} onChange={(event) => setNotifyBaseUrl(event.target.value)} />
                    <span>{callbackPaths.notifyUrl}</span>
                  </div>
                </label>
                {callbackPaths.returnUrl && (
                  <label>
                    <span>同步跳转地址 *</span>
                    <div className="url-join">
                      <input value={returnBaseUrl} placeholder={defaultBaseUrl} onChange={(event) => setReturnBaseUrl(event.target.value)} />
                      <span>{callbackPaths.returnUrl}</span>
                    </div>
                  </label>
                )}
              </div>
            )}

            {providerWebhook && ["stripe", "airwallex", "nowpayments"].includes(providerKey) && (
              <div className="webhook-note">
                {webhookNote(providerKey)}
                <code>{providerWebhook}</code>
              </div>
            )}
          </div>

          {limitableTypes.length > 0 && (
            <div className="form-section">
              <button type="button" className="limits-toggle" onClick={() => setLimitsExpanded((value) => !value)}>
                限额配置
                <ChevronDown size={16} className={`chevron ${limitsExpanded ? "open" : ""}`} />
              </button>
              {limitsExpanded && (
                <div className="limits-body">
                  {limitableTypes.map((item) => (
                    <div key={item.value} className="limit-card">
                      <p>{item.label}</p>
                      <div className="limit-inputs">
                        <label>
                          单笔最低
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="不限制"
                            value={limits[item.value]?.singleMin ?? ""}
                            onChange={(event) => updateLimit(item.value, "singleMin", event.target.value)}
                          />
                        </label>
                        <label>
                          单笔最高
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="不限制"
                            value={limits[item.value]?.singleMax ?? ""}
                            onChange={(event) => updateLimit(item.value, "singleMax", event.target.value)}
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                  <small className="form-hint">留空表示不限制，保存后会在发起支付时检查单笔金额（单位与套餐一致，USD）。</small>
                </div>
              )}
            </div>
          )}
        </form>
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose}>取消</button>
          <button className="button primary" type="submit" form="provider-form" disabled={saving}>保存</button>
        </div>
      </section>
    </div>
  );
}
