import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

export function useResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (background = false) => {
    background ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      setData(await api<T>(path));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加载失败");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
    const refresh = () => { void load(true); };
    window.addEventListener("admin-refresh", refresh);
    return () => window.removeEventListener("admin-refresh", refresh);
  }, [load]);
  return { data, error, loading, refreshing, reload: () => load(true), setData };
}
