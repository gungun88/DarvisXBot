import { useEffect, useState } from "react";
import { api } from "../../api";
import { useToast } from "../Toast";
import type { PageResult, PaymentProvider } from "../../types";
import { PaymentProviderDialog, type ProviderSavePayload } from "./PaymentProviderDialog";
import { PaymentProviderList } from "./PaymentProviderList";

export function PaymentProvidersPanel() {
  const [providers, setProviders] = useState<PaymentProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PaymentProvider | null>(null);
  const toast = useToast();

  async function loadProviders() {
    setLoading(true);
    try {
      const result = await api<Pick<PageResult<PaymentProvider>, "items">>("/api/admin/payment-providers");
      setProviders(result.items);
    } catch (caught) {
      toast.notify(errorMessage(caught, "加载支付服务商失败"), "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadProviders(); }, []);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  async function openEdit(provider: PaymentProvider) {
    setSaving(true);
    try {
      const detail = await api<PaymentProvider>(`/api/admin/payment-providers/${provider.id}?reveal=true`);
      setEditing(detail);
      setDialogOpen(true);
    } catch (caught) {
      toast.notify(errorMessage(caught, "加载服务商详情失败"), "error");
    } finally {
      setSaving(false);
    }
  }

  async function saveProvider(payload: ProviderSavePayload) {
    setSaving(true);
    try {
      if (editing?.id) {
        await api(`/api/admin/payment-providers/${editing.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api("/api/admin/payment-providers", { method: "POST", body: JSON.stringify(payload) });
      }
      toast.notify("支付服务商已保存");
      setDialogOpen(false);
      setEditing(null);
      await loadProviders();
    } catch (caught) {
      toast.notify(errorMessage(caught, "保存失败"), "error");
    } finally {
      setSaving(false);
    }
  }

  async function toggleField(provider: PaymentProvider, field: "enabled" | "refundEnabled") {
    try {
      await api(`/api/admin/payment-providers/${provider.id}`, { method: "PATCH", body: JSON.stringify({ [field]: !provider[field] }) });
      await loadProviders();
    } catch (caught) {
      toast.notify(errorMessage(caught, "切换失败"), "error");
    }
  }

  async function toggleType(provider: PaymentProvider, type: string) {
    const nextTypes = provider.supportedTypes.includes(type)
      ? provider.supportedTypes.filter((item) => item !== type)
      : [...provider.supportedTypes, type];
    if (!nextTypes.length) {
      toast.notify("至少保留一种支付方式", "error");
      return;
    }
    try {
      await api(`/api/admin/payment-providers/${provider.id}`, { method: "PATCH", body: JSON.stringify({ supportedTypes: nextTypes }) });
      await loadProviders();
    } catch (caught) {
      toast.notify(errorMessage(caught, "切换失败"), "error");
    }
  }

  async function deleteProvider(provider: PaymentProvider) {
    if (!window.confirm(`确定删除服务商「${provider.name}」吗？`)) return;
    try {
      await api(`/api/admin/payment-providers/${provider.id}`, { method: "DELETE" });
      toast.notify("支付服务商已删除");
      await loadProviders();
    } catch (caught) {
      toast.notify(errorMessage(caught, "删除失败"), "error");
    }
  }

  return (
    <>
      <PaymentProviderList
        providers={providers}
        loading={loading}
        saving={saving}
        onRefresh={() => void loadProviders()}
        onCreate={openCreate}
        onEdit={(provider) => void openEdit(provider)}
        onDelete={(provider) => void deleteProvider(provider)}
        onToggleField={(provider, field) => void toggleField(provider, field)}
        onToggleType={(provider, type) => void toggleType(provider, type)}
      />
      <PaymentProviderDialog
        show={dialogOpen}
        saving={saving}
        editing={editing}
        onClose={() => setDialogOpen(false)}
        onSave={(payload) => void saveProvider(payload)}
      />
    </>
  );
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
