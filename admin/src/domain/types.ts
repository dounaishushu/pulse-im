// Flexible records are limited to the retained Go compatibility boundary and schema forms.
export type RecordData = Record<string, any>;
export interface AdminAccount extends RecordData {
  id: number;
  username: string;
  role: "admin" | "operator" | "auditor";
  permissions: string[];
  is_super_admin: boolean;
}
export interface PageResult<T = RecordData> {
  items: T[];
  total: number;
  page: number;
  size: number;
  has_more?: boolean;
  [key: string]: any;
}
export interface FieldOption {
  label: string;
  value: string | number | boolean;
}
export interface FormField {
  key: string;
  label: string;
  type?:
    | "text"
    | "password"
    | "textarea"
    | "number"
    | "select"
    | "switch"
    | "time"
    | "date"
    | "datetime"
    | "image";
  options?: FieldOption[];
  required?: boolean;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  help?: string;
  wide?: boolean;
}
export interface TableColumn {
  key: string;
  label: string;
  width?: number;
  minWidth?: number;
  format?: (row: RecordData) => string;
  tag?: (
    row: RecordData,
  ) => "success" | "warning" | "danger" | "info" | "primary";
}
export interface AdminTransport {
  entryKey: string;
  csrfKey: string;
  request<T = RecordData>(
    path: string,
    options?: RequestInit & { body?: any },
  ): Promise<T>;
  fetch(path: string, options?: RequestInit): Promise<Response>;
  upload<T = RecordData>(
    path: string,
    form: FormData,
    signal?: AbortSignal,
  ): Promise<T>;
  download(path: string, signal?: AbortSignal): Promise<Response>;
  reset(): void;
  local(type: string, id: string): number;
  wire(type: string, id: string | number): string;
  mediaURL(value: string): string;
  mediaBlob(id: string, signal?: AbortSignal): Promise<string>;
}
declare global {
  interface Window {
    PulseGoAdmin: AdminTransport;
    PulseRegistrationMap?: { name: string; code: string; path: string }[];
  }
}
