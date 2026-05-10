import { create } from "zustand";

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  userEmail: string | null;
  setSession: (accessToken: string, refreshToken: string | null | undefined, userEmail: string) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: localStorage.getItem("pagebridge.accessToken"),
  refreshToken: null,
  userEmail: localStorage.getItem("pagebridge.userEmail"),
  setSession: (accessToken, refreshToken, userEmail) => {
    localStorage.setItem("pagebridge.accessToken", accessToken);
    localStorage.removeItem("pagebridge.refreshToken");
    localStorage.setItem("pagebridge.userEmail", userEmail);
    set({ accessToken, refreshToken: refreshToken ?? null, userEmail });
  },
  clearSession: () => {
    localStorage.removeItem("pagebridge.accessToken");
    localStorage.removeItem("pagebridge.refreshToken");
    localStorage.removeItem("pagebridge.userEmail");
    set({ accessToken: null, refreshToken: null, userEmail: null });
  }
}));
