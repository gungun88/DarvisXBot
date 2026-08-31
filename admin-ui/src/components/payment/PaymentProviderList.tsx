import { Plus } from "lucide-react";
import { EmptyState, LoadingState, RefreshButton } from "../Ui";
import type { PaymentProvider } from "../../types";
import { ProviderCard } from "./ProviderCard";

type Props = {
  providers: PaymentProvider[];
  loading: boolean;
  saving: boolean;
  onRefresh: () => void;
  onCreate: () => void;
  onEdit: (provider: PaymentProvider) => void;
  onDelete: (provider: PaymentProvider) => void;
  onToggleField: (provider: PaymentProvider, field: "enabled" | "refundEnabled") => void;
  onToggleType: (provider: PaymentProvider, type: string) => void;
};

export function PaymentProviderList({ providers, loading, saving, onRefresh, onCreate, onEdit, onDelete, onToggleField, onToggleType }: Props) {
  return (
    <section className="panel provider-panel">
      <div className="panel-header">
        <div>
          <h2>服务商管理</h2>
          <p>管理支付服务商实例，Bot 下单时使用第一个已启用的服务商</p>
        </div>
        <div className="page-actions">
          <RefreshButton onClick={onRefresh} spinning={loading} />
          <button className="button primary" disabled={saving} onClick={onCreate}><Plus size={16} />添加服务商</button>
        </div>
      </div>
      <div className="provider-list-body">
        {loading && !providers.length
          ? <LoadingState />
          : providers.length
            ? providers.map((provider) => (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  onEdit={() => onEdit(provider)}
                  onDelete={() => onDelete(provider)}
                  onToggleField={(field) => onToggleField(provider, field)}
                  onToggleType={(type) => onToggleType(provider, type)}
                />
              ))
            : <EmptyState title="暂无服务商，点击右上角添加易支付、支付宝、微信、Stripe、Airwallex 或 NOWPayments" />}
      </div>
    </section>
  );
}
