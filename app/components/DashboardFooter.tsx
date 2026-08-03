import { memo } from "react";
import { version as DASHBOARD_VERSION } from "../../package.json";

export const DashboardFooter = memo(function DashboardFooter({
  collectorVersion,
}: {
  collectorVersion: string | undefined;
}) {
  return (
    <footer className="dashboard-footer">
      <p>
        <span />
        Usage layers are never summed · missing observations labeled as such
      </p>
      <p>
        Collector {collectorVersion || DASHBOARD_VERSION} ·
        auto-refresh every 60s
      </p>
    </footer>
  );
});
