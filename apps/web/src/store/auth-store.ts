import { create } from "zustand";

interface AuthState {
  accessToken: string | null;
  userEmail: string | null;
  setSession: (accessToken: string, userEmail: string) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: localStorage.getItem("pagebridge.accessToken"),
  userEmail: localStorage.getItem("pagebridge.userEmail"),
  setSession: (accessToken, userEmail) => {
    localStorage.setItem("pagebridge.accessToken", accessToken);
    localStorage.setItem("pagebridge.userEmail", userEmail);
    set({ accessToken, userEmail });
  },
  clearSession: () => {
    localStorage.removeItem("pagebridge.accessToken");
    localStorage.removeItem("pagebridge.userEmail");
    set({ accessToken: null, userEmail: null });
  }
}));
