import { useQuery } from "@tanstack/react-query";
import { BoxIcon } from "lucide-react";
import { worksApi } from "~/app/api/client";
import { NavItem } from "./nav-item";

export function ModuleNav() {
  const modules = useQuery(worksApi().modules.list.queryOptions());
  return (
    modules.data?.map((module) => (
      <NavItem
        icon={BoxIcon}
        key={module.id}
        label={module.name}
        to={`/m/${encodeURIComponent(module.id)}`}
      />
    )) ?? null
  );
}
