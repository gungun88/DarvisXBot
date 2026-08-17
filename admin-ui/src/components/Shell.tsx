import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
    Activity,
    Bot,
    CalendarClock,
    ChevronLeft,
    ChevronRight,
    CircleGauge,
    Command,
    Gift,
    History,
    LogOut,
    Menu,
    Moon,
    RefreshCw,
    Search,
    ShieldCheck,
    Sun,
    Users,
    WalletCards,
    Crown,
    ShieldAlert,
    UserCog,
    X,
    type LucideIcon,
} from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { getAdminUser, logout as logoutRequest } from "../api";

type NavigationItem = { to: string; label: string; description: string; icon: LucideIcon; ownerOnly?: boolean };
type NavigationGroup = { label: string; items: NavigationItem[] };

const navigation: NavigationGroup[] = [
    {
        label: "总览",
        items: [{ to: "/dashboard", label: "运营仪表盘", description: "业务与系统核心指标", icon: CircleGauge }],
    },
    {
        label: "业务管理",
        items: [
            { to: "/chats", label: "群组管理", description: "群组状态、规则与配置", icon: ShieldCheck },
            { to: "/users", label: "用户管理", description: "用户资料与积分余额", icon: Users },
            { to: "/memberships", label: "会员与支付", description: "会员有效期与支付订单", icon: Crown },
            { to: "/moderation", label: "风控事件", description: "违规命中与自动处罚记录", icon: ShieldAlert },
        ],
    },
    {
        label: "互动运营",
        items: [
            { to: "/scheduled", label: "定时消息", description: "消息计划与投递状态", icon: CalendarClock },
            { to: "/giveaways", label: "抽奖活动", description: "活动进度与开奖结果", icon: Gift },
            { to: "/points", label: "积分流水", description: "积分记录与人工调整", icon: WalletCards },
        ],
    },
    {
        label: "系统管理",
        items: [
            { to: "/operations", label: "运行状态", description: "依赖、队列与服务健康", icon: Activity },
            { to: "/admin-accounts", label: "管理员账号", description: "角色、状态与访问凭据", icon: UserCog, ownerOnly: true },
            { to: "/audit", label: "审计日志", description: "管理员操作记录", icon: History },
        ],
    },
];

export function Shell() {
    const location = useLocation();
    const navigate = useNavigate();
    const searchRef = useRef<HTMLInputElement>(null);
    const [mobileOpen, setMobileOpen] = useState(false);
    const [collapsed, setCollapsed] = useState(() => localStorage.getItem("darvisx-sidebar") === "collapsed");
    const [theme, setTheme] = useState(() => localStorage.getItem("darvisx-theme") ?? "light");
    const [refreshing, setRefreshing] = useState(false);
    const [query, setQuery] = useState("");
    const [searchOpen, setSearchOpen] = useState(false);
    const adminUser = getAdminUser();

    const items = useMemo(
        () => navigation.flatMap((group) => group.items).filter((item) => !item.ownerOnly || adminUser?.role === "owner"),
        [adminUser?.role],
    );
    const current = useMemo(
        () => items.find((item) => location.pathname.startsWith(item.to)),
        [items, location.pathname],
    );
    const currentSection = useMemo(
        () => navigation.find((group) => group.items.some((item) => location.pathname.startsWith(item.to)))?.label,
        [location.pathname],
    );
    const searchResults = useMemo(() => {
        const normalized = query.trim().toLowerCase();
        if (!normalized) return items;
        return items.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(normalized));
    }, [items, query]);

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem("darvisx-theme", theme);
    }, [theme]);

    useEffect(() => {
        setMobileOpen(false);
        setSearchOpen(false);
        setQuery("");
    }, [location.pathname]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                setSearchOpen(true);
                window.setTimeout(() => searchRef.current?.focus(), 0);
            }
            if (event.key === "Escape") {
                setSearchOpen(false);
                searchRef.current?.blur();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    const refresh = () => {
        setRefreshing(true);
        window.dispatchEvent(new Event("admin-refresh"));
        window.setTimeout(() => setRefreshing(false), 700);
    };

    const logout = () => {
        void logoutRequest().finally(() => navigate("/login", { replace: true }));
    };

    const toggleCollapsed = () => {
        setCollapsed((value) => {
            localStorage.setItem("darvisx-sidebar", value ? "expanded" : "collapsed");
            return !value;
        });
    };

    const openItem = (item: NavigationItem) => {
        navigate(item.to);
        setSearchOpen(false);
        setQuery("");
    };

    const submitSearch = (event: FormEvent) => {
        event.preventDefault();
        if (searchResults[0]) openItem(searchResults[0]);
    };

    return <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
        {mobileOpen && <button className="sidebar-scrim" onClick={() => setMobileOpen(false)} aria-label="关闭导航" />}
        <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
            <div className="brand">
                <div className="brand-mark"><Bot size={20} /></div>
                <div className="brand-copy"><strong>DarvisXBot</strong><span>运营管理控制台</span></div>
                <button className="icon-button mobile-close" onClick={() => setMobileOpen(false)} title="关闭导航"><X size={18} /></button>
            </div>
            <nav className="sidebar-nav">
                {navigation.map((group) => <div className="nav-group" key={group.label}>
                    <span className="nav-label">{group.label}</span>
                    {group.items.filter((item) => !item.ownerOnly || adminUser?.role === "owner").map(({ to, label, description, icon: Icon }) => <NavLink
                        key={to}
                        to={to}
                        title={collapsed ? label : description}
                        className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
                    >
                        <Icon size={19} />
                        <span>{label}</span>
                    </NavLink>)}
                </div>)}
            </nav>
            <div className="sidebar-footer">
                <div className="sidebar-account">
                    <span className="account-avatar">{adminUser?.username.slice(0, 1).toUpperCase() ?? "A"}</span>
                    <div><strong>{adminUser?.username ?? "管理员"}</strong><small>{adminUser?.role ?? "owner"}</small></div>
                </div>
                <button className="nav-item logout-item" onClick={logout} title="退出登录"><LogOut size={18} /><span>退出登录</span></button>
                <button className="collapse-button" onClick={toggleCollapsed} title={collapsed ? "展开侧栏" : "收起侧栏"}>
                    {collapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
                </button>
            </div>
        </aside>
        <div className="workspace">
            <header className="topbar">
                <div className="topbar-title">
                    <button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} title="打开导航"><Menu size={19} /></button>
                    <div>
                        <small>{currentSection ?? "管理控制台"}</small>
                        <span>{current?.label ?? "管理控制台"}</span>
                    </div>
                </div>
                <form className={`quick-search ${searchOpen ? "open" : ""}`} onSubmit={submitSearch}>
                    <Search size={17} />
                    <input
                        ref={searchRef}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onFocus={() => setSearchOpen(true)}
                        placeholder="搜索后台功能"
                        aria-label="搜索后台功能"
                    />
                    <span className="search-shortcut"><Command size={12} />K</span>
                    {searchOpen && <div className="search-results">
                        {searchResults.length ? searchResults.map((item) => <button type="button" key={item.to} onMouseDown={() => openItem(item)}>
                            <item.icon size={17} />
                            <span><strong>{item.label}</strong><small>{item.description}</small></span>
                            <ChevronRight size={15} />
                        </button>) : <div className="search-empty">没有匹配的功能</div>}
                    </div>}
                </form>
                <div className="topbar-actions">
                    <button className="icon-button" onClick={refresh} title="刷新当前页面"><RefreshCw className={refreshing ? "spin" : ""} size={18} /></button>
                    <button className="icon-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title={theme === "dark" ? "切换浅色模式" : "切换深色模式"}>
                        {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
                    </button>
                </div>
            </header>
            <main className="content"><Outlet /></main>
        </div>
    </div>;
}
