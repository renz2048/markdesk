declare module "markdown-it-task-lists" {
  interface TaskListsOptions {
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }

  const taskLists: (
    md: import("markdown-it"),
    options?: TaskListsOptions,
  ) => void;
  export default taskLists;
}
