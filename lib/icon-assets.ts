import search from "lucide-static/icons/search.svg?raw";
import home from "lucide-static/icons/house.svg?raw";
import user from "lucide-static/icons/user.svg?raw";
import bell from "lucide-static/icons/bell.svg?raw";
import settings from "lucide-static/icons/settings.svg?raw";
import menu from "lucide-static/icons/menu.svg?raw";
import chevronRight from "lucide-static/icons/chevron-right.svg?raw";
import plus from "lucide-static/icons/plus.svg?raw";
import star from "lucide-static/icons/star.svg?raw";
import heart from "lucide-static/icons/heart.svg?raw";
import check from "lucide-static/icons/check.svg?raw";
import close from "lucide-static/icons/x.svg?raw";
import image from "lucide-static/icons/image.svg?raw";
export const iconAssets={search,home,user,bell,settings,menu,"chevron-right":chevronRight,plus,star,heart,check,close,image};

export const iconChoices = [
  { id: "search", label: "搜索" },
  { id: "home", label: "首页" },
  { id: "user", label: "用户" },
  { id: "bell", label: "通知" },
  { id: "settings", label: "设置" },
  { id: "menu", label: "菜单" },
  { id: "chevron-right", label: "向右" },
  { id: "plus", label: "加号" },
  { id: "star", label: "星形" },
  { id: "heart", label: "心形" },
  { id: "check", label: "勾选" },
  { id: "close", label: "关闭" },
] as const;
export type IconName = (typeof iconChoices)[number]["id"];
export const symbolPresets = [
  { id: "gift", text: "🎁", label: "礼物" },
  { id: "hint", text: "💡", label: "提示" },
  { id: "life", text: "❤️", label: "爱心" },
  { id: "star", text: "★", label: "星形" },
  { id: "info", text: "ⓘ", label: "信息" },
  { id: "flag", text: "⚑", label: "旗帜" },
] as const;
export const symbolFontFamily = 'Arial, "Microsoft YaHei", "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Symbol", sans-serif';
