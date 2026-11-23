import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";

export const useStatusFeed = () =>
  useQuery({ queryKey: ["statusFeed"], queryFn: () => unwrap(api.GET("/statuses/feed")).then((r) => r.feed) });

export const useMyStatuses = () =>
  useQuery({ queryKey: ["myStatuses"], queryFn: () => unwrap(api.GET("/statuses/mine")).then((r) => r.statuses) });

export const useStatusViews = (id: string) =>
  useQuery({
    queryKey: ["status", id, "views"],
    queryFn: () => unwrap(api.GET("/statuses/{id}/views", { params: { path: { id } } })).then((r) => r.views),
  });

export const useStatusComments = (id: string) =>
  useQuery({
    queryKey: ["status", id, "comments"],
    queryFn: () => unwrap(api.GET("/statuses/{id}/comments", { params: { path: { id } } })).then((r) => r.comments),
  });
