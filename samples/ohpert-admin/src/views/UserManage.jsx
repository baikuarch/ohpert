import { useEffect, useState } from 'react';
import { getUsers } from '../api/client.js';

export default function UserManage() {
  const [users, setUsers] = useState([]);
  useEffect(() => {
    getUsers({ page: 1, size: 20 }).then((res) => setUsers(res.data.list));
  }, []);
  return (
    <div className="user-manage">
      {users.map((u) => (
        <div key={u.id}>{u.nickname}</div>
      ))}
    </div>
  );
}
